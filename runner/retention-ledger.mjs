const API=process.env.GITHUB_API_URL||"https://api.github.com";
export const RETENTION_BRANCH="executor/retention";
export const RETENTION_PREFIX=".executor/retention/";
export const RETENTION_MS=7*24*60*60*1000;

function required(value,label){
  if(typeof value!=="string"||!value)throw new Error(label+" is unavailable");
  return value;
}
function jobId(value){
  if(typeof value!=="string"||!/^j2_[A-Za-z0-9_-]{24,80}$/.test(value))
    throw new Error("retention job_id is invalid");
  return value;
}
function iso(value,label){
  if(typeof value!=="string"||!value)throw new Error(label+" is invalid");
  const ms=Date.parse(value);
  if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value)
    throw new Error(label+" is invalid");
  return Object.freeze({value,ms});
}
function headers(token){
  return {
    Accept:"application/vnd.github+json",
    Authorization:`Bearer ${token}`,
    "X-GitHub-Api-Version":"2026-03-10",
    "User-Agent":"generic-executor-retention",
  };
}
async function request(url,{token,method="GET",body,allow404=false,allow422=false}={}){
  const response=await fetch(url,{
    method,
    headers:body?{...headers(token),"Content-Type":"application/json"}:headers(token),
    body:body?JSON.stringify(body):undefined,
  });
  if(allow404&&response.status===404)return null;
  if(allow422&&response.status===422)return null;
  const value=response.status===204?null:await response.json().catch(()=>null);
  if(!response.ok)throw new Error(`GitHub request failed with ${response.status}`);
  return value;
}
function repoUrl(repository,path){
  return `${API}/repos/${required(repository,"repository")}${path}`;
}
function branchPath(branch){
  return branch.split("/").map(encodeURIComponent).join("/");
}
async function getRef(repository,token,branch,{allow404=false}={}){
  return request(repoUrl(repository,`/git/ref/heads/${branchPath(branch)}`),{token,allow404});
}
async function getCommit(repository,token,sha){
  return request(repoUrl(repository,`/git/commits/${encodeURIComponent(sha)}`),{token});
}
async function getTree(repository,token,treeSha){
  return request(repoUrl(repository,`/git/trees/${encodeURIComponent(treeSha)}?recursive=1`),{token});
}
async function currentTree(repository,token,branch){
  const ref=await getRef(repository,token,branch);
  const sha=ref?.object?.sha;
  if(typeof sha!=="string")throw new Error("retention branch ref is invalid");
  const commit=await getCommit(repository,token,sha);
  const treeSha=commit?.tree?.sha;
  if(typeof treeSha!=="string")throw new Error("retention branch commit is invalid");
  const tree=await getTree(repository,token,treeSha);
  return {sha,treeSha,entries:Array.isArray(tree?.tree)?tree.tree:[]};
}
export async function ensureRetentionBranch({repository,token}){
  required(token,"GITHUB_TOKEN");
  const existing=await getRef(repository,token,RETENTION_BRANCH,{allow404:true});
  if(existing)return existing.object.sha;
  const main=await getRef(repository,token,"main");
  const mainSha=main?.object?.sha;
  if(typeof mainSha!=="string")throw new Error("main branch ref is invalid");
  const created=await request(repoUrl(repository,"/git/refs"),{
    token,method:"POST",allow422:true,
    body:{ref:`refs/heads/${RETENTION_BRANCH}`,sha:mainSha},
  });
  if(created?.object?.sha)return created.object.sha;
  const raced=await getRef(repository,token,RETENTION_BRANCH);
  if(typeof raced?.object?.sha!=="string")throw new Error("retention branch creation failed");
  return raced.object.sha;
}
export function parseRetentionRecord(raw){
  let value;
  try{value=typeof raw==="string"?JSON.parse(raw):raw;}catch{throw new Error("retention record is not JSON");}
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("retention record is invalid");
  const allowed=new Set(["v","job_id","runner_label","accepted_at","expires_at","purge_capsule"]);
  for(const key of Object.keys(value))if(!allowed.has(key))
    throw new Error("retention record contains unknown field");
  if(value.v!==1)throw new Error("retention record version is unsupported");
  const accepted=iso(value.accepted_at,"accepted_at");
  const expires=iso(value.expires_at,"expires_at");
  if(expires.ms-accepted.ms!==RETENTION_MS)throw new Error("retention interval is invalid");
  if(typeof value.runner_label!=="string"||!value.runner_label)
    throw new Error("retention runner_label is invalid");
  if(typeof value.purge_capsule!=="string"||!/^[A-Za-z0-9_-]+$/.test(value.purge_capsule))
    throw new Error("retention purge_capsule is invalid");
  const capsule=Buffer.from(value.purge_capsule,"base64url");
  if(capsule.byteLength<256||capsule.byteLength>1024||capsule.toString("base64url")!==value.purge_capsule)
    throw new Error("retention purge_capsule encoding is invalid");
  return Object.freeze({
    v:1,
    job_id:jobId(value.job_id),
    runner_label:value.runner_label,
    accepted_at:accepted.value,
    accepted_ms:accepted.ms,
    expires_at:expires.value,
    expires_ms:expires.ms,
    purge_capsule:value.purge_capsule,
  });
}
export async function writeRetentionRecord({repository,token,record}){
  const value=parseRetentionRecord(record);
  await ensureRetentionBranch({repository,token});
  const current=await currentTree(repository,token,RETENTION_BRANCH);
  const path=`${RETENTION_PREFIX}${value.job_id}.json`;
  if(current.entries.some(x=>x.type==="blob"&&x.path===path))
    throw new Error("retention record already exists");
  const blob=await request(repoUrl(repository,"/git/blobs"),{
    token,method:"POST",body:{content:JSON.stringify({
      v:1,
      job_id:value.job_id,
      runner_label:value.runner_label,
      accepted_at:value.accepted_at,
      expires_at:value.expires_at,
      purge_capsule:value.purge_capsule,
    }),encoding:"utf-8"},
  });
  if(typeof blob?.sha!=="string")throw new Error("retention record blob creation failed");
  const tree=await request(repoUrl(repository,"/git/trees"),{
    token,method:"POST",
    body:{base_tree:current.treeSha,tree:[{path,mode:"100644",type:"blob",sha:blob.sha}]},
  });
  const commit=await request(repoUrl(repository,"/git/commits"),{
    token,method:"POST",
    body:{message:`retention: accept ${value.job_id}`,tree:tree.sha,parents:[current.sha]},
  });
  await request(repoUrl(repository,`/git/refs/heads/${branchPath(RETENTION_BRANCH)}`),{
    token,method:"PATCH",body:{sha:commit.sha,force:false},
  });
  return value;
}
async function readPath(repository,token,path){
  const body=await request(repoUrl(repository,`/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(RETENTION_BRANCH)}`),{token});
  if(body?.type!=="file"||body?.encoding!=="base64"||typeof body?.content!=="string")
    throw new Error("retention record response is invalid");
  return Buffer.from(body.content.replace(/\s+/g,""),"base64").toString("utf8");
}
export async function listRetentionRecords({repository,token}){
  const ref=await getRef(repository,token,RETENTION_BRANCH,{allow404:true});
  if(!ref)return [];
  const current=await currentTree(repository,token,RETENTION_BRANCH);
  const paths=current.entries
    .filter(x=>x.type==="blob"&&x.path.startsWith(RETENTION_PREFIX)&&x.path.endsWith(".json"))
    .map(x=>x.path)
    .sort();
  const out=[];
  for(const path of paths){
    const record=parseRetentionRecord(await readPath(repository,token,path));
    if(path!==`${RETENTION_PREFIX}${record.job_id}.json`)
      throw new Error("retention record path does not match job_id");
    out.push(record);
  }
  return out;
}
export async function deleteRetentionRecord({repository,token,job_id}){
  const id=jobId(job_id);
  const current=await currentTree(repository,token,RETENTION_BRANCH);
  const path=`${RETENTION_PREFIX}${id}.json`;
  if(!current.entries.some(x=>x.type==="blob"&&x.path===path))return false;
  const tree=await request(repoUrl(repository,"/git/trees"),{
    token,method:"POST",
    body:{base_tree:current.treeSha,tree:[{path,mode:"100644",type:"blob",sha:null}]},
  });
  const commit=await request(repoUrl(repository,"/git/commits"),{
    token,method:"POST",
    body:{message:`retention: purge ${id}`,tree:tree.sha,parents:[current.sha]},
  });
  await request(repoUrl(repository,`/git/refs/heads/${branchPath(RETENTION_BRANCH)}`),{
    token,method:"PATCH",body:{sha:commit.sha,force:false},
  });
  return true;
}
export async function resetRetentionBranchIfIdle({repository,token}){
  const ref=await getRef(repository,token,RETENTION_BRANCH,{allow404:true});
  if(!ref)return false;
  const current=await currentTree(repository,token,RETENTION_BRANCH);
  if(current.entries.some(x=>x.type==="blob"&&x.path.startsWith(RETENTION_PREFIX)&&x.path.endsWith(".json")))
    return false;
  const confirm=await getRef(repository,token,RETENTION_BRANCH);
  if(confirm?.object?.sha!==current.sha)return false;
  const main=await getRef(repository,token,"main");
  const mainSha=main?.object?.sha;
  if(typeof mainSha!=="string")throw new Error("main branch ref is invalid");
  if(current.sha===mainSha)return false;
  await request(repoUrl(repository,`/git/refs/heads/${branchPath(RETENTION_BRANCH)}`),{
    token,method:"PATCH",body:{sha:mainSha,force:true},
  });
  return true;
}
