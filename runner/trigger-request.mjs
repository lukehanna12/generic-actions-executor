import { RUNNERS } from "./request.mjs";

export const TRIGGER_RUNNERS = Object.freeze(new Set(Object.keys(RUNNERS)));

function text(value,label,max){
  if(typeof value!=="string"||!value||value.length>max)throw new Error(label+" is invalid");
  return value;
}

function b64(value,label,min=1,max=4096){
  text(value,label,max*2);
  if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error(label+" must be base64url");
  const bytes=Buffer.from(value,"base64url");
  if(bytes.byteLength<min||bytes.byteLength>max||bytes.toString("base64url")!==value)
    throw new Error(label+" encoding is invalid");
  return value;
}

export function parseTriggerRequest(raw,title){
  if(typeof raw!=="string"||raw.length<30||raw.length>4096)
    throw new Error("trigger body size is invalid");
  let value;
  try{value=JSON.parse(raw);}catch{throw new Error("trigger body is not JSON");}
  if(!value||typeof value!=="object"||Array.isArray(value))
    throw new Error("trigger envelope is invalid");

  const allowed=new Set(["v","job_id","runner_label","purge_capsule"]);
  for(const key of Object.keys(value))if(!allowed.has(key))
    throw new Error("trigger contains unknown field");
  if(value.v!==3)throw new Error("trigger version is unsupported");

  const job=text(value.job_id,"job_id",96);
  if(!/^j2_[A-Za-z0-9_-]{24,80}$/.test(job)||title!==job)
    throw new Error("job identity is invalid");
  if(!TRIGGER_RUNNERS.has(value.runner_label))
    throw new Error("runner label is not allowed");

  return Object.freeze({
    v:3,
    job_id:job,
    runner_label:value.runner_label,
    purge_capsule:b64(value.purge_capsule,"purge_capsule",256,1024),
  });
}
