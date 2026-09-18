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
