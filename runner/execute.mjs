import fs from "node:fs/promises";
import path from "node:path";
import { parseOuterRequest, unwrapAesKey } from "./request.mjs";
import { openInput } from "./crypto.mjs";
import { normalizePrivateInput } from "./private-input.mjs";
import { exactSourceArchive } from "./source-access.mjs";
import { GitHubArchiveMaterializer } from "./source-materializer.mjs";
import { CandidateSupervisorFactory } from "./supervisor-factory.mjs";
import { CandidateEnvironmentEngine } from "./environment-engine.mjs";

async function main(){
  const req=parseOuterRequest(process.env.REQUEST_JSON||"",process.env.REQUEST_TITLE||"");
  const inputKey=unwrapAesKey(process.env.AGENTIC_INPUT_UNWRAP_PRIVATE_KEY_PEM,req.wrapped_input_key);
  const clear=await openInput(req.job_id,req.input_capsule,inputKey);
  const input=normalizePrivateInput(clear,req.runner);
  const archive=await exactSourceArchive(input.source,{issuer:process.env.AGENTIC_FETCH_APP_ISSUER,installationId:process.env.AGENTIC_FETCH_INSTALLATION_ID,privateKeyPem:process.env.AGENTIC_FETCH_APP_PRIVATE_KEY_PEM});
  const materialized=await new GitHubArchiveMaterializer().materialize({input,archive});
  let supervised=null;
  const privateRoot=path.join(process.env.RUNNER_TEMP||"/tmp","agentic-finalize");
  await fs.rm(privateRoot,{recursive:true,force:true});await fs.mkdir(privateRoot,{recursive:true,mode:0o700});
  try{
    const supervisor=await new CandidateSupervisorFactory().forInput(input.runner);
    const prepared=await new CandidateEnvironmentEngine({miseBin:process.env.MISE_BIN||""}).prepare({runner:input.runner,environment:input.environment,validation_plan:input.validation_plan});
    supervised=await supervisor.run({workspace:materialized.workspace,validation_plan:prepared});
    const payload={v:2,job_id:req.job_id,source_commit:input.source.commit_sha,runner:input.runner,outcome:supervised.result.outcome,steps:supervised.result.steps,terminated_at:supervised.terminated_at,group_id:supervised.group_id};
    await fs.writeFile(path.join(privateRoot,"result.clear.json"),JSON.stringify(payload),{mode:0o600});
    console.log("candidate_terminated");
  }finally{
    await supervised?.cleanup?.().catch(()=>{});
    await materialized?.cleanup?.().catch(()=>{});
  }
}
main().catch(()=>{console.error("execution_failed");process.exitCode=1;});
