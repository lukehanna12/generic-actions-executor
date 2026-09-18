function obj(v,l){if(!v||typeof v!=="object"||Array.isArray(v))throw new Error(l+" must be an object");return v;}
function txt(v,l,max=512){if(typeof v!=="string"||!v||v.length>max)throw new Error(l+" is invalid");return v;}
function path(v,l){txt(v,l,1024);if(v.startsWith("/")||v.includes("\\")||v.split("/").includes(".."))throw new Error(l+" escapes repository");return v;}
function step(v,i){obj(v,"step");const a=new Set(["step_id","argv","cwd","timeout_seconds"]);for(const k of Object.keys(v))if(!a.has(k))throw new Error("step contains unknown field");txt(v.step_id,"step_id",128);if(!Array.isArray(v.argv)||v.argv.length<1||v.argv.length>64||v.argv.some(x=>typeof x!=="string"||!x||x.length>4096))throw new Error("step argv is invalid");const t=v.timeout_seconds??900;if(!Number.isSafeInteger(t)||t<1||t>3600)throw new Error("step timeout is invalid");return Object.freeze({step_id:v.step_id,argv:Object.freeze([...v.argv]),cwd:path(v.cwd??".","step cwd"),timeout_seconds:t});}
function runnerTuple(v,expected){
  const runner=obj(v,"runner");
  const fields=["provider","os","version","arch","label"];
  for(const k of Object.keys(runner))if(!fields.includes(k))throw new Error("runner contains unknown field");
  for(const k of fields)if(runner[k]!==expected?.[k])throw new Error("encrypted runner tuple does not match public runner selection");
  return Object.freeze({...expected});
}
export function normalizePrivateInput(input,expectedRunner){
  obj(input,"private input");const allowed=new Set(["v","source","runner","environment","validation_plan"]);for(const k of Object.keys(input))if(!allowed.has(k))throw new Error("private input contains unknown field");if(input.v!==2)throw new Error("private input version is invalid");
  const source=obj(input.source,"source");for(const k of Object.keys(source))if(!["owner","repo","owner_id","repository_id","branch","commit_sha"].includes(k))throw new Error("source contains unknown field");
  const runner=runnerTuple(input.runner,expectedRunner);
  const env=obj(input.environment??{},"environment"),toolchains=env.toolchains??[],packages=env.system_packages??[],setup=env.setup_steps??[];
  if(!Array.isArray(toolchains)||toolchains.length>8||toolchains.some(x=>!x||typeof x.name!=="string"||typeof x.version!=="string"))throw new Error("toolchains are invalid");
  if(!Array.isArray(packages)||packages.length>32||packages.some(x=>!x||typeof x.name!=="string"||(x.version!=null&&typeof x.version!=="string")))throw new Error("system packages are invalid");
  if(!Array.isArray(setup)||setup.length>16)throw new Error("setup steps are invalid");
  const plan=obj(input.validation_plan,"validation plan");txt(plan.plan_id,"plan_id",128);if(!Array.isArray(plan.steps)||plan.steps.length<1||plan.steps.length>32)throw new Error("validation steps are invalid");
  return Object.freeze({v:2,source:Object.freeze({...source}),runner,environment:Object.freeze({toolchains:Object.freeze(toolchains.map(x=>Object.freeze({name:txt(x.name,"toolchain",32),version:txt(x.version,"toolchain version",64)}))),system_packages:Object.freeze(packages.map(x=>Object.freeze({name:txt(x.name,"package",128),...(x.version?{version:txt(x.version,"package version",64)}:{})}))),setup_steps:Object.freeze(setup.map(step))}),validation_plan:Object.freeze({plan_id:plan.plan_id,steps:Object.freeze(plan.steps.map(step))})});
}
