const API=process.env.GITHUB_API_URL||"https://api.github.com";
export const BROKER_RETENTION_BRANCH="executor/broker-retention";
export const BROKER_RETENTION_PREFIX=".executor/broker-retention/";
export const BROKER_RETENTION_MS=7*24*60*60*1000;

function required(value,label){
  if(typeof value!=="string"||!value)throw new Error(label+" is unavailable");
  return value;
}
function transport(value){
  if(typeof value!=="string"||!/^q4_[A-Za-z0-9_-]{24,80}$/.test(value))throw new Error("broker retention transport_id is invalid");
  return value;
}
function branch(value){
  if(typeof value!=="string"||!value||value.length>255||/[\x00-\x20~^:?*[\]\\]/.test(value)||value.includes(".."))throw new Error("broker retention branch is invalid");
  return value;
}
function iso(value,label){
  if(typeof value!=="string"||!value)throw new Error(label+" is invalid");
  const ms=Date.parse(value);
  if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value)throw new Error(label+" is invalid");
  return {value,ms};
}
function headers(token){
  return {Accept:"application/vnd.github+json",Authorization:`Bearer ${token}`,"X-GitHub-Api-Version":"2026-03-10","User-Agent":"generic-executor-broker-retention"};
}
async function request(repository,token,path,{method="GET",body,allow404=false,allow422=false}={}){
  const response=await fetch(`${API}/repos/${required(repository,"repository")}${path}`,{
    method,
    headers:body?{...headers(required(token,"GITHUB_TOKEN")),"Content-Type":"application/json"}:headers(required(token,"GITHUB_TOKEN")),
    body:body?JSON.stringify(body):undefined,
  });
  if(allow404&&response.status===404)return null;
  if(allow422&&response.status===422)return null;
  const value=response.status===204?null:await response.json().catch(()=>null);
  if(!response.ok)throw new Error(`GitHub request failed with ${response.status}`);
  return value;
}
function refPath(value){return value.split("/").map(encodeURIComponent).join("/");}
async function getRef(repository,token,name,{allow404=false}={}){
  return request(repository,token,`/git/ref/heads/${refPath(name)}`,{allow404});
}
async function currentTree(repository,token,name){
  const ref=await getRef(repository,token,name),sha=ref?.object?.sha;
  if(typeof sha!=="string")throw new Error("broker retention ref is invalid");
  const commit=await request(repository,token,`/git/commits/${encodeURIComponent(sha)}`);
  const treeSha=commit?.tree?.sha;
  if(typeof treeSha!=="string")throw new Error("broker retention commit is invalid");
  const tree=await request(repository,token,`/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
  return {sha,treeSha,entries:Array.isArray(tree?.tree)?tree.tree:[]};
}
async function ensureBranch(repository,token){
  const existing=await getRef(repository,token,BROKER_RETENTION_BRANCH,{allow404:true});
  if(existing)return;
  const base=await getRef(repository,token,"main");
  const sha=base?.object?.sha;
  if(typeof sha!=="string")throw new Error("broker retention baseline is invalid");
  const created=await request(repository,token,"/git/refs",{
    method:"POST",allow422:true,body:{ref:`refs/heads/${BROKER_RETENTION_BRANCH}`,sha},
  });
  if(created)return;
  if(!await getRef(repository,token,BROKER_RETENTION_BRANCH,{allow404:true}))throw new Error("broker retention branch creation failed");
}
export function parseBrokerRetentionRecord(raw){
  let value;
  try{value=typeof raw==="string"?JSON.parse(raw):raw;}catch{throw new Error("broker retention record is not JSON");}
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("broker retention record is invalid");
  const allowed=new Set(["v","transport_id","runner_label","branch","baseline_branch","accepted_at","expires_at"]);
  for(const key of Object.keys(value))if(!allowed.has(key))throw new Error("broker retention record contains unknown field");
  if(value.v!==1)throw new Error("broker retention version is invalid");
  const accepted=iso(value.accepted_at,"accepted_at"),expires=iso(value.expires_at,"expires_at");
  if(expires.ms-accepted.ms!==BROKER_RETENTION_MS)throw new Error("broker retention interval is invalid");
  if(typeof value.runner_label!=="string"||!value.runner_label)throw new Error("broker retention runner_label is invalid");
  return Object.freeze({
    v:1,
    transport_id:transport(value.transport_id),
    runner_label:value.runner_label,
    branch:branch(value.branch),
    baseline_branch:branch(value.baseline_branch),
    accepted_at:accepted.value,
    accepted_ms:accepted.ms,
    expires_at:expires.value,
    expires_ms:expires.ms,
  });
}
async function readRecord(repository,token,path){
  const body=await request(repository,token,`/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(BROKER_RETENTION_BRANCH)}`);
  if(body?.type!=="file"||body?.encoding!=="base64"||typeof body?.content!=="string")throw new Error("broker retention record response is invalid");
  return Buffer.from(body.content.replace(/\s+/g,""),"base64").toString("utf8");
}
export async function writeBrokerRetentionRecord({repository,token,record}){
  const value=parseBrokerRetentionRecord(record);
  await ensureBranch(repository,token);
  const path=`${BROKER_RETENTION_PREFIX}${value.transport_id}.json`;
  const content=JSON.stringify({
    v:1,transport_id:value.transport_id,runner_label:value.runner_label,branch:value.branch,baseline_branch:value.baseline_branch,
    accepted_at:value.accepted_at,expires_at:value.expires_at,
  });
  const blob=await request(repository,token,"/git/blobs",{method:"POST",body:{content,encoding:"utf-8"}});
  for(let attempt=0;attempt<10;attempt++){
    const current=await currentTree(repository,token,BROKER_RETENTION_BRANCH);
    if(current.entries.some(x=>x.type==="blob"&&x.path===path)){
      const existing=parseBrokerRetentionRecord(await readRecord(repository,token,path));
      if(existing.runner_label!==value.runner_label||existing.branch!==value.branch||existing.baseline_branch!==value.baseline_branch)
        throw new Error("broker retention identity conflict");
      return existing;
    }
    const tree=await request(repository,token,"/git/trees",{method:"POST",body:{base_tree:current.treeSha,tree:[{path,mode:"100644",type:"blob",sha:blob.sha}]}});
    const commit=await request(repository,token,"/git/commits",{method:"POST",body:{message:"broker: retain",tree:tree.sha,parents:[current.sha]}});
    const updated=await request(repository,token,`/git/refs/heads/${refPath(BROKER_RETENTION_BRANCH)}`,{
      method:"PATCH",allow422:true,body:{sha:commit.sha,force:false},
    });
    if(updated)return value;
  }
  throw new Error("broker retention write conflicted repeatedly");
}
export async function listBrokerRetentionRecords({repository,token}){
  const ref=await getRef(repository,token,BROKER_RETENTION_BRANCH,{allow404:true});
  if(!ref)return [];
  const current=await currentTree(repository,token,BROKER_RETENTION_BRANCH);
  const out=[];
  for(const path of current.entries.filter(x=>x.type==="blob"&&x.path.startsWith(BROKER_RETENTION_PREFIX)&&x.path.endsWith(".json")).map(x=>x.path).sort()){
    const record=parseBrokerRetentionRecord(await readRecord(repository,token,path));
    if(path!==`${BROKER_RETENTION_PREFIX}${record.transport_id}.json`)throw new Error("broker retention path mismatch");
    out.push(record);
  }
  return out;
}
export async function deleteBrokerRetentionRecord({repository,token,transport_id}){
  const id=transport(transport_id),path=`${BROKER_RETENTION_PREFIX}${id}.json`;
  for(let attempt=0;attempt<10;attempt++){
    const ref=await getRef(repository,token,BROKER_RETENTION_BRANCH,{allow404:true});
    if(!ref)return false;
    const current=await currentTree(repository,token,BROKER_RETENTION_BRANCH);
    if(!current.entries.some(x=>x.type==="blob"&&x.path===path))return false;
    const tree=await request(repository,token,"/git/trees",{method:"POST",body:{base_tree:current.treeSha,tree:[{path,sha:null}]}});
    const commit=await request(repository,token,"/git/commits",{method:"POST",body:{message:"broker: purge retention",tree:tree.sha,parents:[current.sha]}});
    const updated=await request(repository,token,`/git/refs/heads/${refPath(BROKER_RETENTION_BRANCH)}`,{
      method:"PATCH",allow422:true,body:{sha:commit.sha,force:false},
    });
    if(updated)return true;
  }
  throw new Error("broker retention deletion conflicted repeatedly");
}
export async function resetBrokerRetentionBranchIfIdle({repository,token}){
  const ref=await getRef(repository,token,BROKER_RETENTION_BRANCH,{allow404:true});
  if(!ref)return false;
  const current=await currentTree(repository,token,BROKER_RETENTION_BRANCH);
  if(current.entries.some(x=>x.type==="blob"&&x.path.startsWith(BROKER_RETENTION_PREFIX)&&x.path.endsWith(".json")))return false;
  const confirm=await getRef(repository,token,BROKER_RETENTION_BRANCH);
  if(confirm?.object?.sha!==current.sha)return false;
  const main=await getRef(repository,token,"main");
  const mainSha=main?.object?.sha;
  if(typeof mainSha!=="string")throw new Error("broker retention main ref is invalid");
  if(current.sha!==mainSha){
    await request(repository,token,`/git/refs/heads/${refPath(BROKER_RETENTION_BRANCH)}`,{
      method:"PATCH",body:{sha:mainSha,force:true},
    });
  }
  return true;
}
