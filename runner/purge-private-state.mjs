import { appJwt } from "./github-app.mjs";
import { openPurgeLocator } from "./purge-locator.mjs";
import {
  deleteRetentionRecord,
  listRetentionRecords,
  resetRetentionBranchIfIdle,
} from "./retention-ledger.mjs";

const API=process.env.GITHUB_API_URL||"https://api.github.com";
const PUBLIC_TOKEN=process.env.GITHUB_TOKEN||"";
const PUBLIC_REPOSITORY=process.env.GITHUB_REPOSITORY||"";

function required(v,l){
  if(typeof v!=="string"||!v)throw new Error(l+" is unavailable");
  return v;
}
function positive(v,l){
  const n=Number(v);
  if(!Number.isSafeInteger(n)||n<1)throw new Error(l+" is invalid");
  return n;
}
function headers(token){
  return {
    Accept:"application/vnd.github+json",
    Authorization:`Bearer ${token}`,
    "X-GitHub-Api-Version":"2026-03-10",
    "User-Agent":"generic-workspace-purge",
  };
}
async function request(url,{token,method="GET",body,allow404=false}={}){
  const response=await fetch(url,{
    method,
    headers:body?{...headers(token),"Content-Type":"application/json"}:headers(token),
    body:body?JSON.stringify(body):undefined,
  });
  if(allow404&&response.status===404)return null;
  const value=response.status===204?null:await response.json().catch(()=>null);
  if(!response.ok)throw new Error(`GitHub request failed with ${response.status}`);
  return value;
}
function privateUrl(repository,path){
  return `${API}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}${path}`;
}
function mask(v){
  if(typeof v==="string"&&v)process.stdout.write(`::add-mask::${v}\n`);
}
async function mintPurgeToken(repositoryId){
  const jwt=appJwt({
    issuer:required(process.env.WORKSPACE_PURGE_APP_ISSUER,"purge app issuer"),
    privateKeyPem:required(process.env.WORKSPACE_PURGE_APP_PRIVATE_KEY_PEM,"purge app private key"),
  });
  const installationId=positive(process.env.WORKSPACE_PURGE_INSTALLATION_ID,"purge installation ID");
  const body=await request(`${API}/app/installations/${installationId}/access_tokens`,{
    token:jwt,
    method:"POST",
    body:{repository_ids:[repositoryId],permissions:{contents:"write"}},
  });
  if(typeof body?.token!=="string"||body?.permissions?.contents!=="write")
    throw new Error("purge token mint failed");
  return body.token;
}
async function revokeToken(token){
  await request(`${API}/installation/token`,{token,method:"DELETE"});
}
async function resolveRepository(token,expectedId){
  const body=await request(`${API}/installation/repositories?per_page=2`,{token});
  const rows=Array.isArray(body?.repositories)?body.repositories:[];
  if(body?.total_count!==1||rows.length!==1||rows[0]?.id!==expectedId||rows[0]?.private!==true)
    throw new Error("purge token repository scope is invalid");
  const owner=rows[0]?.owner?.login,repo=rows[0]?.name;
  if(typeof owner!=="string"||!owner||typeof repo!=="string"||!repo)
    throw new Error("purge repository identity is invalid");
  mask(owner);mask(repo);mask(`${owner}/${repo}`);
  return Object.freeze({owner,repo,id:expectedId});
}
function branchPath(branch){
  return branch.split("/").map(encodeURIComponent).join("/");
}
async function getRef(repository,token,branch,{allow404=false}={}){
  return request(privateUrl(repository,`/git/ref/heads/${branchPath(branch)}`),{token,allow404});
}
async function updateRef(repository,token,branch,sha,{force=false}={}){
  return request(privateUrl(repository,`/git/refs/heads/${branchPath(branch)}`),{
    token,method:"PATCH",body:{sha,force},
  });
}
async function getCommit(repository,token,sha){
  return request(privateUrl(repository,`/git/commits/${encodeURIComponent(sha)}`),{token});
}
async function getTree(repository,token,treeSha){
  return request(privateUrl(repository,`/git/trees/${encodeURIComponent(treeSha)}?recursive=1`),{token});
}
async function currentTree(repository,token,branch){
  const ref=await getRef(repository,token,branch),sha=ref?.object?.sha;
  if(typeof sha!=="string")throw new Error("branch ref is invalid");
  const commit=await getCommit(repository,token,sha),treeSha=commit?.tree?.sha;
  if(typeof treeSha!=="string")throw new Error("branch commit is invalid");
  const tree=await getTree(repository,token,treeSha);
  return {sha,treeSha,entries:Array.isArray(tree?.tree)?tree.tree:[]};
}
async function deleteRecord(repository,token,branch,path){
  const current=await currentTree(repository,token,branch);
  if(!current.entries.some(x=>x.type==="blob"&&x.path===path))return false;
  const tree=await request(privateUrl(repository,"/git/trees"),{
    token,method:"POST",
    body:{base_tree:current.treeSha,tree:[{path,mode:"100644",type:"blob",sha:null}]},
  });
  const commit=await request(privateUrl(repository,"/git/commits"),{
    token,method:"POST",
    body:{message:"purge: expire transient job record",tree:tree.sha,parents:[current.sha]},
  });
  await updateRef(repository,token,branch,commit.sha,{force:false});
  return true;
}
function jobRecords(entries,prefix){
  return entries.filter(x=>x.type==="blob"&&x.path.startsWith(prefix)&&x.path.endsWith(".json"));
}
async function resetStateBranchIfIdle({repository,token,branch,prefix,baselineSha,allowReset}){
  if(!allowReset)return false;
  const current=await currentTree(repository,token,branch);
  if(jobRecords(current.entries,prefix).length!==0)return false;
  const confirm=await getRef(repository,token,branch);
  if(confirm?.object?.sha!==current.sha)return false;
  if(current.sha!==baselineSha)
    await updateRef(repository,token,branch,baselineSha,{force:true});
  return true;
}
async function resetWorkspaceIfSafe({repository,token,locator,baselineSha,allowReset}){
  if(!allowReset)return false;
  const ref=await getRef(repository,token,locator.source_branch,{allow404:true});
  if(!ref)return false;
  const current=ref?.object?.sha;
  if(current!==locator.source_sha)return false;
  const confirm=await getRef(repository,token,locator.source_branch);
  if(confirm?.object?.sha!==current)return false;
  if(current!==baselineSha)
    await updateRef(repository,token,locator.source_branch,baselineSha,{force:true});
  return true;
}
async function purgeRecord(item,allItems){
  const locator=item.locator;
  const isLater=o=>
    o.record.accepted_ms>item.record.accepted_ms||
    (
      o.record.accepted_ms===item.record.accepted_ms&&
      o.record.job_id.localeCompare(item.record.job_id)>0
    );
  const newerRepo=allItems.some(o=>
    isLater(o)&&o.locator.repository_id===locator.repository_id
  );
  const newerWorkspace=allItems.some(o=>
    isLater(o)&&
    o.locator.repository_id===locator.repository_id&&
    o.locator.source_branch===locator.source_branch
  );
  const token=await mintPurgeToken(locator.repository_id);
  try{
    const repository=await resolveRepository(token,locator.repository_id);
    const baseline=await getRef(repository,token,locator.baseline_branch);
    const baselineSha=baseline?.object?.sha;
    if(typeof baselineSha!=="string")throw new Error("baseline branch is invalid");

    await deleteRecord(
      repository,token,locator.dispatch_branch,
      `.executor/dispatch/${item.record.job_id}.json`,
    );
    await deleteRecord(
      repository,token,locator.keys_branch,
      `.agentic/result-keys/${item.record.job_id}.json`,
    );

    await resetStateBranchIfIdle({
      repository,token,branch:locator.dispatch_branch,
      prefix:".executor/dispatch/",baselineSha,allowReset:!newerRepo,
    });
    await resetStateBranchIfIdle({
      repository,token,branch:locator.keys_branch,
      prefix:".agentic/result-keys/",baselineSha,allowReset:!newerRepo,
    });
    await resetWorkspaceIfSafe({
      repository,token,locator,baselineSha,allowReset:!newerWorkspace,
    });
  }finally{
    await revokeToken(token).catch(()=>{});
  }
}

async function main(){
  required(PUBLIC_TOKEN,"GITHUB_TOKEN");
  required(PUBLIC_REPOSITORY,"GITHUB_REPOSITORY");
  const unwrapKey=required(
    process.env.AGENTIC_INPUT_UNWRAP_PRIVATE_KEY_PEM,
    "input unwrap private key",
  );

  const records=await listRetentionRecords({
    repository:PUBLIC_REPOSITORY,
    token:PUBLIC_TOKEN,
  });
  const items=[];
  for(const record of records){
    let locator;
    try{locator=openPurgeLocator(unwrapKey,record.purge_capsule);}
    catch{
      throw new Error(`purge locator rejected for job ${record.job_id}`);
    }
    items.push({record,locator});
  }

  const now=Date.now();
  const eligible=items
    .filter(x=>x.record.expires_ms<=now)
    .sort((a,b)=>a.record.accepted_ms-b.record.accepted_ms);

  for(const item of eligible){
    try{
      await purgeRecord(item,items);
      await deleteRetentionRecord({
        repository:PUBLIC_REPOSITORY,
        token:PUBLIC_TOKEN,
        job_id:item.record.job_id,
      });
      console.log(`retention_purged job=${item.record.job_id}`);
    }catch{
      console.error(`retention_purge_failed job=${item.record.job_id}`);
      process.exitCode=1;
      break;
    }
  }

  await resetRetentionBranchIfIdle({
    repository:PUBLIC_REPOSITORY,
    token:PUBLIC_TOKEN,
  }).catch(()=>{
    console.error("retention_branch_reset_failed");
    process.exitCode=1;
  });

  console.log(`retention_scan_complete eligible=${eligible.length}`);
}
main().catch(()=>{
  console.error("retention_purge_failed");
  process.exitCode=1;
});
