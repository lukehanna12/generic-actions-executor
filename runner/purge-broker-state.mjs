import {
  deleteBrokerRetentionRecord,
  listBrokerRetentionRecords,
  resetBrokerRetentionBranchIfIdle,
} from "./broker-retention.mjs";

const API=process.env.GITHUB_API_URL||"https://api.github.com";
const TOKEN=process.env.GITHUB_TOKEN||"";
const REPOSITORY=process.env.GITHUB_REPOSITORY||"";

function required(value,label){
  if(typeof value!=="string"||!value)throw new Error(label+" is unavailable");
  return value;
}
function headers(){
  return {Accept:"application/vnd.github+json",Authorization:`Bearer ${required(TOKEN,"GITHUB_TOKEN")}`,"X-GitHub-Api-Version":"2026-03-10","User-Agent":"generic-executor-broker-purge"};
}
async function request(path,{method="GET",body,allow404=false,allow422=false}={}){
  const response=await fetch(`${API}/repos/${required(REPOSITORY,"GITHUB_REPOSITORY")}${path}`,{
    method,headers:body?{...headers(),"Content-Type":"application/json"}:headers(),body:body?JSON.stringify(body):undefined,
  });
  if(allow404&&response.status===404)return null;
  if(allow422&&response.status===422)return null;
  const value=response.status===204?null:await response.json().catch(()=>null);
  if(!response.ok)throw new Error(`GitHub request failed with ${response.status}`);
  return value;
}
function refPath(value){return value.split("/").map(encodeURIComponent).join("/");}
async function getRef(branch,{allow404=false}={}){
  return request(`/git/ref/heads/${refPath(branch)}`,{allow404});
}
async function currentTree(branch,{allow404=false}={}){
  const ref=await getRef(branch,{allow404});
  if(!ref)return null;
  const sha=ref?.object?.sha;
  if(typeof sha!=="string")throw new Error("broker purge ref is invalid");
  const commit=await request(`/git/commits/${encodeURIComponent(sha)}`),treeSha=commit?.tree?.sha;
  if(typeof treeSha!=="string")throw new Error("broker purge commit is invalid");
  const tree=await request(`/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
  return {sha,treeSha,entries:Array.isArray(tree?.tree)?tree.tree:[]};
}
async function purgeTransport(record){
  for(let attempt=0;attempt<10;attempt++){
    const current=await currentTree(record.branch,{allow404:true});
    if(!current)return;
    const inputPath=`in/${record.transport_id}.bin`;
    const outputPrefix=`out/${record.transport_id}/`;
    const deletions=[];
    if(current.entries.some(x=>x.type==="blob"&&x.path===inputPath))deletions.push({path:inputPath,sha:null});
    for(const entry of current.entries.filter(x=>x.type==="blob"&&x.path.startsWith(outputPrefix)))
      deletions.push({path:entry.path,sha:null});
    if(!deletions.length)return;
    const tree=await request("/git/trees",{method:"POST",body:{base_tree:current.treeSha,tree:deletions}});
    const commit=await request("/git/commits",{method:"POST",body:{message:"broker: purge state",tree:tree.sha,parents:[current.sha]}});
    const updated=await request(`/git/refs/heads/${refPath(record.branch)}`,{
      method:"PATCH",allow422:true,body:{sha:commit.sha,force:false},
    });
    if(updated)return;
  }
  throw new Error("broker state purge conflicted repeatedly");
}
async function resetRuntimeBranchIfIdle(record){
  const remaining=await listBrokerRetentionRecords({repository:REPOSITORY,token:TOKEN});
  if(remaining.some(x=>x.branch===record.branch))return false;
  const current=await currentTree(record.branch,{allow404:true});
  if(!current)return false;
  if(current.entries.some(x=>x.type==="blob"&&(x.path.startsWith("in/")||x.path.startsWith("out/"))))return false;
  const baseline=await getRef(record.baseline_branch);
  const baselineSha=baseline?.object?.sha;
  if(typeof baselineSha!=="string")throw new Error("broker baseline ref is invalid");
  const confirm=await getRef(record.branch);
  if(confirm?.object?.sha!==current.sha)return false;
  if(current.sha!==baselineSha){
    await request(`/git/refs/heads/${refPath(record.branch)}`,{
      method:"PATCH",body:{sha:baselineSha,force:true},
    });
  }
  return true;
}
async function main(){
  required(TOKEN,"GITHUB_TOKEN");required(REPOSITORY,"GITHUB_REPOSITORY");
  const records=await listBrokerRetentionRecords({repository:REPOSITORY,token:TOKEN});
  const eligible=records.filter(x=>x.expires_ms<=Date.now()).sort((a,b)=>a.accepted_ms-b.accepted_ms);
  for(const record of eligible){
    try{
      await purgeTransport(record);
      await deleteBrokerRetentionRecord({repository:REPOSITORY,token:TOKEN,transport_id:record.transport_id});
      await resetRuntimeBranchIfIdle(record);
      console.log("broker_retention_purged");
    }catch{
      console.error("broker_retention_purge_failed");
      process.exitCode=1;
      break;
    }
  }
  await resetBrokerRetentionBranchIfIdle({repository:REPOSITORY,token:TOKEN}).catch(()=>{
    console.error("broker_retention_branch_reset_failed");
    process.exitCode=1;
  });
  console.log(`broker_retention_scan_complete eligible=${eligible.length}`);
}
main().catch(()=>{console.error("broker_retention_purge_failed");process.exitCode=1;});
