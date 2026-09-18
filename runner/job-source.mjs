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
