import fs from "node:fs/promises";
import path from "node:path";
import { parseOuterRequest, unwrapAesKey } from "./request.mjs";
import { sealResult } from "./crypto.mjs";
async function main(){
  const req=parseOuterRequest(process.env.REQUEST_JSON||"",process.env.REQUEST_TITLE||"");
  const privateRoot=path.join(process.env.RUNNER_TEMP||"/tmp","agentic-finalize"),clearPath=path.join(privateRoot,"result.clear.json"),outPath=path.join(process.cwd(),"capsule.bin");
  let clear;
  try{clear=JSON.parse(await fs.readFile(clearPath,"utf8"));}catch{throw new Error("clear result is unavailable");}
  if(clear?.job_id!==req.job_id)throw new Error("clear result job mismatch");
  const resultKey=unwrapAesKey(process.env.AGENTIC_RESULT_UNWRAP_PRIVATE_KEY_PEM,req.wrapped_result_key);
  try{
    const capsule=await sealResult(req.job_id,clear,resultKey);
    await fs.writeFile(outPath,capsule,{mode:0o600,flag:"wx"});
    console.log("result_sealed");
  }finally{
    await fs.rm(privateRoot,{recursive:true,force:true}).catch(()=>{});
  }
}
main().catch(()=>{console.error("finalize_failed");process.exitCode=1;});
