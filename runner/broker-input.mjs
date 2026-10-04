import { Buffer } from "node:buffer";

const JOB_RE=/^j4_[A-Za-z0-9_-]{24,80}$/;
const MAX_ARCHIVE_BYTES=48*1024*1024;
const MAX_PAYLOAD_JSON_BYTES=1024*1024;

function object(value,label){
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(label+" must be an object");
  return value;
}
function text(value,label,max=512){
  if(typeof value!=="string"||!value||value.length>max)throw new Error(label+" is invalid");
  return value;
}
function relativePath(value,label){
  text(value,label,1024);
  if(value.startsWith("/")||value.includes("\\")||value.split("/").includes(".."))throw new Error(label+" escapes workspace");
  return value;
}
function step(value){
  object(value,"step");
  const allowed=new Set(["step_id","argv","cwd","timeout_seconds"]);
  for(const key of Object.keys(value))if(!allowed.has(key))throw new Error("step contains unknown field");
  const id=text(value.step_id,"step_id",128);
  if(!Array.isArray(value.argv)||value.argv.length<1||value.argv.length>64||value.argv.some(x=>typeof x!=="string"||!x||x.length>4096))
    throw new Error("step argv is invalid");
  const timeout=value.timeout_seconds??900;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>3600)throw new Error("step timeout is invalid");
  return Object.freeze({step_id:id,argv:Object.freeze([...value.argv]),cwd:relativePath(value.cwd??".","step cwd"),timeout_seconds:timeout});
}
function runnerTuple(value,expected){
  const runner=object(value,"runner");
  const fields=["provider","os","version","arch","label"];
  for(const key of Object.keys(runner))if(!fields.includes(key))throw new Error("runner contains unknown field");
  for(const key of fields)if(runner[key]!==expected?.[key])throw new Error("encrypted runner tuple does not match public runner selection");
  return Object.freeze({...expected});
}
function base64urlArchive(value){
  if(value==null||value==="")return "";
  if(typeof value!=="string"||!/^[A-Za-z0-9_-]+$/.test(value))throw new Error("workspace_archive must be base64url");
  const raw=Buffer.from(value,"base64url");
  if(raw.length<1||raw.length>MAX_ARCHIVE_BYTES||raw.toString("base64url")!==value)throw new Error("workspace_archive encoding is invalid");
  return value;
}
function payload(value){
  if(value===undefined)return null;
  let encoded;
  try{encoded=JSON.stringify(value);}catch{throw new Error("payload is not JSON-serializable");}
  if(encoded===undefined||Buffer.byteLength(encoded,"utf8")>MAX_PAYLOAD_JSON_BYTES)throw new Error("payload is too large");
  return value;
}

export function normalizeBrokerInput(input,expectedRunner){
  object(input,"broker input");
  const allowed=new Set(["v","job_id","models","runner","environment","validation_plan","payload","workspace_archive","stream_interval_seconds"]);
  for(const key of Object.keys(input))if(!allowed.has(key))throw new Error("broker input contains unknown field");
  if(input.v!==4)throw new Error("broker input version is invalid");
  if(typeof input.job_id!=="string"||!JOB_RE.test(input.job_id))throw new Error("broker job_id is invalid");
  const models=input.models??[];
  if(!Array.isArray(models)||models.length>16||models.some(x=>typeof x!=="string"||!x||x.length>128))
    throw new Error("broker models are invalid");
  const runner=runnerTuple(input.runner,expectedRunner);
  const env=object(input.environment??{},"environment");
  const toolchains=env.toolchains??[],packages=env.system_packages??[],setup=env.setup_steps??[];
  if(!Array.isArray(toolchains)||toolchains.length>8||toolchains.some(x=>!x||typeof x.name!=="string"||typeof x.version!=="string"))throw new Error("toolchains are invalid");
  if(!Array.isArray(packages)||packages.length>32||packages.some(x=>!x||typeof x.name!=="string"||(x.version!=null&&typeof x.version!=="string")))throw new Error("system packages are invalid");
  if(!Array.isArray(setup)||setup.length>16)throw new Error("setup steps are invalid");
  const plan=object(input.validation_plan,"validation plan");
  text(plan.plan_id,"plan_id",128);
  if(!Array.isArray(plan.steps)||plan.steps.length<1||plan.steps.length>32)throw new Error("validation steps are invalid");
  const interval=input.stream_interval_seconds??30;
  if(!Number.isSafeInteger(interval)||interval<10||interval>300)throw new Error("stream interval is invalid");
  return Object.freeze({
    v:4,
    job_id:input.job_id,
    models:Object.freeze([...models]),
    runner,
    environment:Object.freeze({
      toolchains:Object.freeze(toolchains.map(x=>Object.freeze({name:text(x.name,"toolchain",32),version:text(x.version,"toolchain version",64)}))),
      system_packages:Object.freeze(packages.map(x=>Object.freeze({name:text(x.name,"package",128),...(x.version?{version:text(x.version,"package version",64)}:{})}))),
      setup_steps:Object.freeze(setup.map(step)),
    }),
    validation_plan:Object.freeze({plan_id:plan.plan_id,steps:Object.freeze(plan.steps.map(step))}),
    payload:payload(input.payload),
    workspace_archive:base64urlArchive(input.workspace_archive),
    stream_interval_seconds:interval,
  });
}

export const BROKER_MAX_ARCHIVE_BYTES=MAX_ARCHIVE_BYTES;
