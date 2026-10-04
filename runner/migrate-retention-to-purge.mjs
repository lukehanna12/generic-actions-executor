import { constants, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt } from "node:crypto";
import { Buffer } from "node:buffer";
import { listRetentionRecords, RETENTION_MS, writeRetentionRecord } from "./retention-ledger.mjs";

const API=process.env.GITHUB_API_URL||"https://api.github.com";
const TOKEN=process.env.GITHUB_TOKEN||"";
const REPOSITORY=process.env.GITHUB_REPOSITORY||"";
const OWNER=process.env.GITHUB_REPOSITORY_OWNER||"";
const OLD_MAGIC=Buffer.from("workspace-cleanup-locator-v1\0","utf8");
const NEW_MAGIC=Buffer.from("workspace-purge-locator-v1\0","utf8");

function required(v,label){if(typeof v!=="string"||!v)throw new Error(label+" is unavailable");return v;}
function headers(token){return {Accept:"application/vnd.github+json",Authorization:`Bearer ${token}`,"X-GitHub-Api-Version":"2026-03-10","User-Agent":"retention-purge-migration"};}
async function request(path){
  const response=await fetch(`${API}/repos/${REPOSITORY}${path}`,{headers:headers(TOKEN)});
  const value=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(`GitHub request failed with ${response.status}`);
  return value;
}
function b64(value){
  if(typeof value!=="string"||!/^[A-Za-z0-9_-]+$/.test(value))throw new Error("legacy capsule is invalid");
  const bytes=Buffer.from(value,"base64url");
  if(bytes.byteLength<256||bytes.byteLength>1024||bytes.toString("base64url")!==value)throw new Error("legacy capsule encoding is invalid");
  return bytes;
}
function parseLegacyIssue(issue){
  if(issue?.user?.login!==OWNER||issue?.pull_request)return null;
  const labels=new Set((issue.labels||[]).map(x=>typeof x==="string"?x:x?.name).filter(Boolean));
  if(labels.has("retention-cleaned"))return null;
  let body;
  try{body=JSON.parse(issue.body||"");}catch{return null;}
  if(!body||typeof body!=="object"||Array.isArray(body)||body.v!==2)return null;
  if(typeof body.job_id!=="string"||body.job_id!==issue.title||!/^j2_[A-Za-z0-9_-]{24,80}$/.test(body.job_id))return null;
  if(typeof body.runner_label!=="string"||!body.runner_label)return null;
  try{b64(body.cleanup_capsule);}catch{return null;}
  const created=Date.parse(issue.created_at||"");
  if(!Number.isFinite(created))throw new Error("legacy issue creation time is invalid");
  return {job_id:body.job_id,runner_label:body.runner_label,created_ms:created,cleanup_capsule:body.cleanup_capsule};
}
function rewrap(privateKeyPem,encoded){
  const key=createPrivateKey(privateKeyPem);
  const clear=privateDecrypt({key,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},b64(encoded));
  if(clear.byteLength<=OLD_MAGIC.byteLength||!clear.subarray(0,OLD_MAGIC.byteLength).equals(OLD_MAGIC))
    throw new Error("legacy locator magic is invalid");
  const payload=clear.subarray(OLD_MAGIC.byteLength);
  let value;
  try{value=JSON.parse(payload.toString("utf8"));}catch{throw new Error("legacy locator payload is invalid");}
  if(!value||typeof value!=="object"||Array.isArray(value)||value.v!==1)throw new Error("legacy locator payload is invalid");
  const publicKey=createPublicKey(key);
  return publicEncrypt({
    key:publicKey,
    padding:constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash:"sha256",
  },Buffer.concat([NEW_MAGIC,Buffer.from(JSON.stringify(value),"utf8")])).toString("base64url");
}
async function listIssues(){
  const out=[];
  for(let page=1;page<=100;page++){
    const rows=await request(`/issues?state=all&per_page=100&page=${page}&sort=created&direction=asc`);
    if(!Array.isArray(rows))throw new Error("issue listing is invalid");
    out.push(...rows);
    if(rows.length<100)break;
  }
  return out;
}
async function main(){
  required(TOKEN,"GITHUB_TOKEN");required(REPOSITORY,"GITHUB_REPOSITORY");required(OWNER,"GITHUB_REPOSITORY_OWNER");
  const privateKeyPem=required(process.env.AGENTIC_INPUT_UNWRAP_PRIVATE_KEY_PEM,"input unwrap private key");
  const existing=new Set((await listRetentionRecords({repository:REPOSITORY,token:TOKEN})).map(x=>x.job_id));
  let migrated=0,skipped=0;
  for(const issue of await listIssues()){
    const legacy=parseLegacyIssue(issue);
    if(!legacy)continue;
    if(existing.has(legacy.job_id)){skipped++;continue;}
    const acceptedAt=new Date(legacy.created_ms).toISOString();
    const expiresAt=new Date(legacy.created_ms+RETENTION_MS).toISOString();
    await writeRetentionRecord({
      repository:REPOSITORY,
      token:TOKEN,
      record:{
        v:1,
        job_id:legacy.job_id,
        runner_label:legacy.runner_label,
        accepted_at:acceptedAt,
        expires_at:expiresAt,
        purge_capsule:rewrap(privateKeyPem,legacy.cleanup_capsule),
      },
    });
    existing.add(legacy.job_id);
    migrated++;
  }
  console.log(`purge_migration_complete migrated=${migrated} skipped=${skipped}`);
}
main().catch(error=>{console.error("purge_migration_failed: "+error.message);process.exitCode=1;});
