import { Buffer } from "node:buffer";
import { appJwt } from "./github-app.mjs";

export const REQUEST_RECORD_BRANCH = "executor/dispatch";
const H=Object.freeze({
  Accept:"application/vnd.github+json",
  "X-GitHub-Api-Version":"2022-11-28",
  "User-Agent":"generic-encrypted-executor",
});

function positive(value,label){
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<1)throw new Error(label+" is invalid");
  return n;
}

function job(value){
  if(typeof value!=="string"||!/^j2_[A-Za-z0-9_-]{24,80}$/.test(value))
    throw new Error("request record job_id is invalid");
  return value;
}

function validatePermissions(permissions){
  if(!permissions||typeof permissions!=="object"||Array.isArray(permissions))
    throw new Error("request token permissions are invalid");
  if(permissions.contents!=="read")
    throw new Error("request token lacks contents:read");
  for(const [name,level] of Object.entries(permissions)){
    if(name==="contents")continue;
    if(name==="metadata"&&level==="read")continue;
    if(level!=="none")throw new Error("request token has unexpected permissions");
  }
}

export async function mintRequestToken({issuer,installationId,privateKeyPem}={}){
  const jwt=appJwt({issuer,privateKeyPem});
  const response=await fetch(
    `https://api.github.com/app/installations/${positive(installationId,"installation ID")}/access_tokens`,
    {
      method:"POST",
      headers:{...H,Authorization:`Bearer ${jwt}`,"Content-Type":"application/json"},
      body:JSON.stringify({permissions:{contents:"read"}}),
    },
  );
  const body=await response.json().catch(()=>null);
  if(!response.ok||typeof body?.token!=="string")
    throw new Error("request token mint failed");
  validatePermissions(body.permissions);
  return body.token;
}


export async function revokeRequestToken(token){
  const response=await fetch("https://api.github.com/installation/token",{
    method:"DELETE",
    headers:{...H,Authorization:`Bearer ${token}`},
  });
  if(response.status!==204)throw new Error("request token revocation failed");
}

export async function resolveOnlyRequestRepository(token){
  const response=await fetch(
    "https://api.github.com/installation/repositories?per_page=2",
    {headers:{...H,Authorization:`Bearer ${token}`}},
  );
  const body=await response.json().catch(()=>null);
  if(!response.ok)throw new Error("request repository lookup failed");
  const repositories=Array.isArray(body?.repositories)?body.repositories:[];
  if(body?.total_count!==1||repositories.length!==1||repositories[0]?.private!==true)
    throw new Error("request installation is not narrowed to one private repository");
  const repository=repositories[0];
  const owner=repository?.owner?.login;
  const repo=repository?.name;
  if(typeof owner!=="string"||!owner||typeof repo!=="string"||!repo)
    throw new Error("request repository identity is invalid");
  return Object.freeze({owner,repo});
}
