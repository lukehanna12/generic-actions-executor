import fs from "node:fs/promises";
import path from "node:path";
import { parseTriggerRequest } from "./trigger-request.mjs";
import { fetchRequestRecord } from "./job-source.mjs";
import { parseOuterRequest, unwrapAesKey } from "./request.mjs";
import { openInput } from "./crypto.mjs";
import { normalizePrivateInput } from "./private-input.mjs";
import { exactSourceArchive } from "./source-access.mjs";
import { GitHubArchiveMaterializer } from "./source-materializer.mjs";
import { CandidateSupervisorFactory } from "./supervisor-factory.mjs";
import { CandidateEnvironmentEngine } from "./environment-engine.mjs";

export const EXECUTOR_V3_READY = true;


let stage="start";
function passed(name){
  stage=name;
  console.log("phase="+name);
}

async function loadExecution(){
  const trigger=parseTriggerRequest(
    process.env.REQUEST_JSON||"",
    process.env.REQUEST_TITLE||"",
  );
  passed("trigger_validated");

  const record=await fetchRequestRecord({
    job_id:trigger.job_id,
    issuer:process.env.AGENTIC_FETCH_APP_ISSUER,
    installationId:process.env.AGENTIC_FETCH_INSTALLATION_ID,
    privateKeyPem:process.env.AGENTIC_FETCH_APP_PRIVATE_KEY_PEM,
  });
  passed("request_record_loaded");

  const request=parseOuterRequest(
    JSON.stringify(record),
    trigger.job_id,
  );
  if(request.runner_label!==trigger.runner_label)
    throw new Error("request record runner does not match trigger");
  passed("request_record_validated");

  const inputKey=unwrapAesKey(
    process.env.AGENTIC_INPUT_UNWRAP_PRIVATE_KEY_PEM,
    request.wrapped_input_key,
  );
  passed("input_key_unwrapped");

  const clear=await openInput(
    request.job_id,
    request.input_capsule,
    inputKey,
  );
  passed("input_opened");

  const input=normalizePrivateInput(clear,request.runner);
  passed("input_normalized");

  const archive=await exactSourceArchive(input.source,{
    issuer:process.env.AGENTIC_FETCH_APP_ISSUER,
    installationId:process.env.AGENTIC_FETCH_INSTALLATION_ID,
    privateKeyPem:process.env.AGENTIC_FETCH_APP_PRIVATE_KEY_PEM,
  });
  passed("source_archive_issued");

  const materialized=await new GitHubArchiveMaterializer().materialize({
    input,
    archive,
  });
  passed("source_materialized");

  return Object.freeze({trigger,request,input,materialized});
}


async function runCandidate({request,input,materialized}){
  let supervised=null;
  const privateRoot=path.join(
    process.env.RUNNER_TEMP||"/tmp",
    "executor-finalize",
  );
  await fs.rm(privateRoot,{recursive:true,force:true});
  await fs.mkdir(privateRoot,{recursive:true,mode:0o700});

  try{
    const supervisor=await new CandidateSupervisorFactory().forInput(input.runner);
    passed("supervisor_selected");

    const prepared=await new CandidateEnvironmentEngine({
      miseBin:process.env.MISE_BIN||"",
    }).prepare({
      runner:input.runner,
      environment:input.environment,
      validation_plan:input.validation_plan,
    });
    passed("environment_prepared");

    supervised=await supervisor.run({
      workspace:materialized.workspace,
      validation_plan:prepared,
    });
    passed("candidate_terminated");

    const result={
      v:3,
      job_id:request.job_id,
      source_commit:input.source.commit_sha,
      runner:input.runner,
      outcome:supervised.result.outcome,
      steps:supervised.result.steps,
      terminated_at:supervised.terminated_at,
      group_id:supervised.group_id,
    };
    const finalize={
      v:1,
      job_id:request.job_id,
      wrapped_result_key:request.wrapped_result_key,
    };

    await Promise.all([
      fs.writeFile(
        path.join(privateRoot,"result.clear.json"),
        JSON.stringify(result),
        {mode:0o600},
      ),
      fs.writeFile(
        path.join(privateRoot,"finalize.json"),
        JSON.stringify(finalize),
        {mode:0o600},
      ),
    ]);
    passed("clear_result_staged");
  }finally{
    await supervised?.cleanup?.().catch(()=>{});
    await materialized?.cleanup?.().catch(()=>{});
  }
}

async function main(){
  const execution=await loadExecution();
  await runCandidate(execution);
}

main().catch(()=>{
  console.error("execution_failed_phase="+stage);
  process.exitCode=1;
});
