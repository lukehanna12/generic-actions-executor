import { appJwt } from "./github-app.mjs";
const H=Object.freeze({Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2026-03-10","User-Agent":"generic-encrypted-executor"});
function positive(v,label){const n=Number(v);if(!Number.isSafeInteger(n)||n<1)throw new Error(label+" is invalid");return n;}
function name(v,label){if(typeof v!=="string"||!v||v.length>100||!/^[A-Za-z0-9_.-]+$/.test(v))throw new Error(label+" is invalid");return v;}
function branch(v){if(typeof v!=="string"||!v||v.length>240||v.startsWith("/")||v.endsWith("/")||v.includes("..")||v.includes("@{")||v.includes("\\")||/[\x00-\x20~^:?*\[]/.test(v)||v.split("/").some(x=>!x||x.endsWith(".lock")))throw new Error("source branch is invalid");return v;}
function sha(v){if(typeof v!=="string"||!/^[0-9a-f]{40}$/.test(v))throw new Error("source commit is invalid");return v;}
async function revoke(token){const r=await fetch("https://api.github.com/installation/token",{method:"DELETE",headers:{...H,Authorization:`Bearer ${token}`}});if(r.status!==204)throw new Error("installation token revocation failed");}
export async function exactSourceArchive(source,{issuer,installationId,privateKeyPem}={}){
  if(!source||typeof source!=="object"||Array.isArray(source))throw new Error("source selector is invalid");
  const owner=name(source.owner,"source owner"),repo=name(source.repo,"source repository"),ownerId=positive(source.owner_id,"source owner ID"),repoId=positive(source.repository_id,"source repository ID"),ref=branch(source.branch),commit=sha(source.commit_sha);
  const jwt=appJwt({issuer,privateKeyPem});
  const tokenResponse=await fetch(`https://api.github.com/app/installations/${positive(installationId,"installation ID")}/access_tokens`,{method:"POST",headers:{...H,Authorization:`Bearer ${jwt}`,"Content-Type":"application/json"},body:JSON.stringify({repository_ids:[repoId],permissions:{contents:"read"}})});
  const tokenData=await tokenResponse.json().catch(()=>null);
  if(!tokenResponse.ok||typeof tokenData?.token!=="string")throw new Error("runner-fetch token mint failed");
  const repos=Array.isArray(tokenData.repositories)?tokenData.repositories:[];
  if(tokenData.permissions?.contents!=="read"||repos.length!==1||repos[0]?.id!==repoId||repos[0]?.owner?.id!==ownerId||repos[0]?.full_name!==`${owner}/${repo}`)throw new Error("runner-fetch token scope mismatch");
  const token=tokenData.token;
  try{
    const headers={...H,Authorization:`Bearer ${token}`};
    const meta=await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,{headers});
    const m=await meta.json().catch(()=>null);
    if(!meta.ok||m?.id!==repoId||m?.owner?.id!==ownerId||m?.private!==true)throw new Error("private source identity mismatch");
    const head=await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,{headers});
    const h=await head.json().catch(()=>null);
    if(!head.ok||h?.sha!==commit)throw new Error("source commit is not the exact current branch head");
    const archive=await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${commit}`,{headers,redirect:"manual"});
    if(archive.status!==302)throw new Error("source archive issuance failed");
    const location=archive.headers.get("location"),u=new URL(location||"");
    if(u.protocol!=="https:"||u.hostname!=="codeload.github.com"||u.username||u.password)throw new Error("source archive redirect is invalid");
    return Object.freeze({commit_sha:commit,archive_url:u.href,expires_at:new Date(Date.now()+4*60*1000).toISOString()});
  }finally{await revoke(token);}
}
