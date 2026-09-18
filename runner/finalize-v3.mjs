import fs from "node:fs/promises";
import path from "node:path";
import { parseTriggerRequest } from "./trigger-request.mjs";
import { unwrapAesKey } from "./request.mjs";
import { sealResult } from "./crypto.mjs";

async function main(){
  const trigger=parseTriggerRequest(
    process.env.REQUEST_JSON||"",
    process.env.REQUEST_TITLE||"",
  );

  const privateRoot=path.join(
    process.env.RUNNER_TEMP||"/tmp",
    "executor-finalize",
  );
  const clearPath=path.join(privateRoot,"result.clear.json");
  const finalizePath=path.join(privateRoot,"finalize.json");
  const outPath=path.join(process.cwd(),"capsule.bin");

  let clear;
  let finalize;
  try{
    clear=JSON.parse(await fs.readFile(clearPath,"utf8"));
    finalize=JSON.parse(await fs.readFile(finalizePath,"utf8"));
  }catch{
    throw new Error("finalization state is unavailable");
  }

  if(
    clear?.job_id!==trigger.job_id||
    finalize?.job_id!==trigger.job_id||
    finalize?.v!==1||
    typeof finalize?.wrapped_result_key!=="string"
  )throw new Error("finalization state does not match trigger");

  const resultKey=unwrapAesKey(
    process.env.AGENTIC_RESULT_UNWRAP_PRIVATE_KEY_PEM,
    finalize.wrapped_result_key,
  );

  try{
    const capsule=await sealResult(
      trigger.job_id,
      clear,
      resultKey,
    );
    await fs.writeFile(outPath,capsule,{
      mode:0o600,
      flag:"wx",
    });
    console.log("result_sealed");
  }finally{
    await fs.rm(privateRoot,{recursive:true,force:true}).catch(()=>{});
  }
}

main().catch(()=>{
  console.error("finalize_failed");
  process.exitCode=1;
});
