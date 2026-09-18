export const TRIGGER_RUNNERS = Object.freeze(new Set([
  "ubuntu-22.04",
  "ubuntu-22.04-arm",
  "ubuntu-24.04",
  "ubuntu-24.04-arm",
  "macos-14",
  "macos-15",
  "macos-15-intel",
  "macos-26",
  "macos-26-intel",
]));

function text(value,label,max){
  if(typeof value!=="string"||!value||value.length>max)
    throw new Error(label+" is invalid");
  return value;
}

export function parseTriggerRequest(raw,title){
  if(typeof raw!=="string"||raw.length<30||raw.length>512)
    throw new Error("trigger body size is invalid");
  let value;
  try{value=JSON.parse(raw);}
  catch{throw new Error("trigger body is not JSON");}
  if(!value||typeof value!=="object"||Array.isArray(value))
    throw new Error("trigger envelope is invalid");
  const allowed=new Set(["v","job_id","runner_label"]);
  for(const key of Object.keys(value))
    if(!allowed.has(key))throw new Error("trigger contains unknown field");
  if(value.v!==1)throw new Error("trigger version is unsupported");
  const job=text(value.job_id,"job_id",96);
  if(!/^j2_[A-Za-z0-9_-]{24,80}$/.test(job)||title!==job)
    throw new Error("job identity is invalid");
  if(!TRIGGER_RUNNERS.has(value.runner_label))
    throw new Error("runner label is not allowed");
  return Object.freeze({v:1,job_id:job,runner_label:value.runner_label});
}
