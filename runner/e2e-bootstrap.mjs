import { randomBytes, publicEncrypt, constants, createPublicKey, createCipheriv } from "node:crypto";
import { Buffer } from "node:buffer";
import { appJwt } from "./github-app.mjs";
import { RUNNERS } from "./request.mjs";

const API=process.env.GITHUB_API_URL||"https://api.github.com";
const PUBLIC_REPOSITORY=process.env.GITHUB_REPOSITORY||"";
const PUBLIC_TOKEN=process.env.GITHUB_TOKEN||"";
const ISSUE_NUMBER=Number(process.env.E2E_CONTROL_ISSUE||"0");
const REPOSITORY_ID=Number(process.env.E2E_REPOSITORY_ID||"0");
const SOURCE_BRANCH=process.env.E2E_SOURCE_BRANCH||"";
const SOURCE_SHA=process.env.E2E_SOURCE_SHA||"";
const BASELINE_BRANCH="main";
const DISPATCH_BRANCH="executor/dispatch";
const KEYS_BRANCH="agentic/keys";
const INPUT_MAGIC=Buffer.from("COLINP1","utf8");
const CLEANUP_MAGIC=Buffer.from("workspace-cleanup-locator-v1\0","utf8");
const INPUT_BUCKETS=[4096,16384,32768];
const TARGETS=["ubuntu-26.04","ubuntu-slim","xcode-27","windows-2025","windows-11-arm"];

function required(v,label){if(typeof v!=="string"||!v)throw new Error(label+" is unavailable");return v;}
function positive(v,label){if(!Number.isSafeInteger(v)||v<1)throw new Error(label+" is invalid");return v;}
function mask(v){if(typeof v==="string"&&v)process.stdout.write(`::add-mask::${v}\n`);}
function headers(token){return {Accept:"application/vnd.github+json",Authorization:`Bearer ${token}`,"X-GitHub-Api-Version":"2022-11-28","User-Agent":"generic-executor-e2e-bootstrap"};}
async function request(url,{token,method="GET",body,allow404=false}={}){
  const response=await fetch(url,{method,headers:body?{...headers(token),"Content-Type":"application/json"}:headers(token),body:body?JSON.stringify(body):undefined});
  if(allow404&&response.status===404)return null;
  const value=response.status===204?null:await response.json().catch(()=>null);
  if(!response.ok)throw new Error(`GitHub request failed with ${response.status}`);
  return value;
}
function privateUrl(repository,path){return `${API}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}${path}`;}
function branchPath(branch){return branch.split("/").map(encodeURIComponent).join("/");}
async function getRef(repository,token,branch){return request(privateUrl(repository,`/git/ref/heads/${branchPath(branch)}`),{token});}
async function getCommit(repository,token,sha){return request(privateUrl(repository,`/git/commits/${encodeURIComponent(sha)}`),{token});}
async function getTree(repository,token,treeSha){return request(privateUrl(repository,`/git/trees/${encodeURIComponent(treeSha)}?recursive=1`),{token});}
async function currentTree(repository,token,branch){
  const ref=await getRef(repository,token,branch),sha=ref?.object?.sha;
  if(typeof sha!=="string")throw new Error("branch ref is invalid");
  const commit=await getCommit(repository,token,sha),treeSha=commit?.tree?.sha;
  if(typeof treeSha!=="string")throw new Error("branch commit is invalid");
  const tree=await getTree(repository,token,treeSha);
  return {sha,treeSha,entries:Array.isArray(tree?.tree)?tree.tree:[]};
}
async function mintCleanupToken(){
  const jwt=appJwt({issuer:required(process.env.WORKSPACE_CLEANUP_APP_ISSUER,"cleanup app issuer"),privateKeyPem:required(process.env.WORKSPACE_CLEANUP_APP_PRIVATE_KEY_PEM,"cleanup app private key")});
  const installationId=positive(Number(process.env.WORKSPACE_CLEANUP_INSTALLATION_ID),"cleanup installation ID");
  const body=await request(`${API}/app/installations/${installationId}/access_tokens`,{token:jwt,method:"POST",body:{repository_ids:[positive(REPOSITORY_ID,"repository ID")],permissions:{contents:"write"}}});
  if(typeof body?.token!=="string"||body?.permissions?.contents!=="write")throw new Error("cleanup token mint failed");
  return body.token;
}
async function revoke(token){await request(`${API}/installation/token`,{token,method:"DELETE"});}
async function resolveRepository(token){
  const body=await request(`${API}/installation/repositories?per_page=2`,{token});
  const rows=Array.isArray(body?.repositories)?body.repositories:[];
  if(body?.total_count!==1||rows.length!==1||rows[0]?.id!==REPOSITORY_ID||rows[0]?.private!==true)throw new Error("cleanup token repository scope is invalid");
  const owner=rows[0]?.owner?.login,ownerId=rows[0]?.owner?.id,repo=rows[0]?.name;
  if(typeof owner!=="string"||!owner||!Number.isSafeInteger(ownerId)||typeof repo!=="string"||!repo)throw new Error("cleanup repository identity is invalid");
  mask(owner);mask(repo);mask(`${owner}/${repo}`);
  return Object.freeze({owner,ownerId,repo,id:REPOSITORY_ID});
}
async function readText(repository,token,path,ref){
  const url=privateUrl(repository,`/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
  const body=await request(url,{token});
  if(body?.type!=="file"||body?.encoding!=="base64"||typeof body?.content!=="string")throw new Error("private text file response is invalid");
  return Buffer.from(body.content.replace(/\s+/g,""),"base64").toString("utf8");
}
async function addFiles(repository,token,branch,files,message){
  const current=await currentTree(repository,token,branch);
  for(const path of Object.keys(files))if(current.entries.some(x=>x.type==="blob"&&x.path===path))throw new Error("E2E job record unexpectedly already exists");
  const entries=[];
  for(const [path,content] of Object.entries(files)){
    const blob=await request(privateUrl(repository,"/git/blobs"),{token,method:"POST",body:{content,encoding:"utf-8"}});
    if(typeof blob?.sha!=="string")throw new Error("blob creation failed");
    entries.push({path,mode:"100644",type:"blob",sha:blob.sha});
  }
  const tree=await request(privateUrl(repository,"/git/trees"),{token,method:"POST",body:{base_tree:current.treeSha,tree:entries}});
  const commit=await request(privateUrl(repository,"/git/commits"),{token,method:"POST",body:{message,tree:tree.sha,parents:[current.sha]}});
  await request(privateUrl(repository,`/git/refs/heads/${branchPath(branch)}`),{token,method:"PATCH",body:{sha:commit.sha,force:false}});
}
function b64u(bytes){return Buffer.from(bytes).toString("base64url");}
function wrap(publicKey,key){
  return publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},key).toString("base64url");
}
function sealInput(job,input,key){
  const clear=Buffer.from(JSON.stringify(input),"utf8");
  const bucket=INPUT_BUCKETS.find(size=>4+clear.length<=size-INPUT_MAGIC.length-12-16);
  if(!bucket)throw new Error("private E2E input exceeds capsule ceiling");
  const plaintext=Buffer.alloc(bucket-INPUT_MAGIC.length-12-16);
  plaintext.writeUInt32BE(clear.length,0);clear.copy(plaintext,4);
  const iv=randomBytes(12);
  const cipher=createCipheriv("aes-256-gcm",key,iv);
  cipher.setAAD(Buffer.from(`stateless-executor-input-v1|${job}|${bucket}`,"utf8"));
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]);
  const capsule=Buffer.concat([INPUT_MAGIC,iv,ciphertext]);
  if(capsule.length!==bucket)throw new Error("private E2E input capsule length mismatch");
  return b64u(capsule);
}
function jobId(){return `j2_${randomBytes(24).toString("base64url")}`;}
function cleanupCapsule(publicKey,source){
  const locator={v:1,repository_id:source.repository_id,baseline_branch:BASELINE_BRANCH,source_branch:source.branch,source_sha:source.commit_sha,dispatch_branch:DISPATCH_BRANCH,keys_branch:KEYS_BRANCH};
  return publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},Buffer.concat([CLEANUP_MAGIC,Buffer.from(JSON.stringify(locator),"utf8")])).toString("base64url");
}
async function commentTriggers(triggers){
  const url=`${API}/repos/${PUBLIC_REPOSITORY}/issues/${positive(ISSUE_NUMBER,"control issue")}/comments`;
  await request(url,{token:required(PUBLIC_TOKEN,"GITHUB_TOKEN"),method:"POST",body:{body:`E2E_TRIGGERS_V1\n\`\`\`json\n${JSON.stringify(triggers)}\n\`\`\``}});
}

async function main(){
  required(PUBLIC_REPOSITORY,"GITHUB_REPOSITORY");required(PUBLIC_TOKEN,"GITHUB_TOKEN");positive(ISSUE_NUMBER,"control issue");positive(REPOSITORY_ID,"repository ID");
  if(!/^[0-9a-f]{40}$/.test(SOURCE_SHA))throw new Error("source SHA is invalid");
  if(!SOURCE_BRANCH)throw new Error("source branch is unavailable");
  const token=await mintCleanupToken();
  try{
    const repository=await resolveRepository(token);
    const sourceRef=await getRef(repository,token,SOURCE_BRANCH);
    if(sourceRef?.object?.sha!==SOURCE_SHA)throw new Error("E2E source branch no longer matches expected SHA");
    const inputPem=await readText(repository,token,".agentic/crypto/input-wrap-public.pem",BASELINE_BRANCH);
    const resultPem=await readText(repository,token,".agentic/crypto/result-wrap-public.pem",BASELINE_BRANCH);
    const inputPublic=createPublicKey(inputPem),resultPublic=createPublicKey(resultPem);
    const source={owner:repository.owner,repo:repository.repo,owner_id:repository.ownerId,repository_id:repository.id,branch:SOURCE_BRANCH,commit_sha:SOURCE_SHA};
    const dispatchFiles={},keyFiles={},triggers=[];
    const probe="const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));console.log(JSON.stringify({ok:p.name==='agentic-workspace',name:p.name,platform:process.platform,arch:process.arch,node:process.version}))";
    for(const label of TARGETS){
      const runner=RUNNERS[label];if(!runner)throw new Error("target runner is absent from trusted registry");
      const job=jobId(),inputKey=randomBytes(32),resultKey=randomBytes(32);
      const input={v:2,source,runner,environment:{toolchains:[{name:"node",version:"24.21.0"}],system_packages:[],setup_steps:[]},validation_plan:{plan_id:`executor-e2e-${label}-20261004`,steps:[{step_id:"source-toolchain-probe",argv:["node","-e",probe],cwd:".",timeout_seconds:240}]}};
      const record={v:2,job_id:job,runner_label:label,wrapped_input_key:wrap(inputPublic,inputKey),input_capsule:sealInput(job,input,inputKey),wrapped_result_key:wrap(resultPublic,resultKey)};
      dispatchFiles[`.executor/dispatch/${job}.json`]=JSON.stringify(record);
      keyFiles[`.agentic/result-keys/${job}.json`]=JSON.stringify({v:1,job_id:job,result_key:b64u(resultKey)});
      triggers.push({v:2,job_id:job,runner_label:label,cleanup_capsule:cleanupCapsule(inputPublic,source)});
    }
    await addFiles(repository,token,KEYS_BRANCH,keyFiles,"test: stage E2E result keys");
    await addFiles(repository,token,DISPATCH_BRANCH,dispatchFiles,"test: stage E2E dispatch records");
    await commentTriggers(triggers);
    console.log("e2e_bootstrap_complete targets=5");
  }finally{
    await revoke(token).catch(()=>{});
  }
}
main().catch(()=>{console.error("e2e_bootstrap_failed");process.exitCode=1;});
