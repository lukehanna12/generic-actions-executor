import fs from "node:fs";
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { brokerTransportIdFromPath, openBrokerInput, parseBrokerEnvelope } from "./broker-envelope.mjs";
import { normalizeBrokerInput } from "./broker-input.mjs";
import { RUNNERS, unwrapAesKey } from "./request.mjs";
import { BROKER_RETENTION_MS, listBrokerRetentionRecords, writeBrokerRetentionRecord } from "./broker-retention.mjs";

const exec=promisify(execFile);

function required(value,label){
  if(typeof value!=="string"||!value)throw new Error(label+" is unavailable");
  return value;
}
function sha(value,label){
  if(typeof value!=="string"||!/^[0-9a-f]{40}$/.test(value))throw new Error(label+" is invalid");
  return value;
}
async function changedInputPath(before,after){
  const {stdout}=await exec("git",["diff","--name-status",before,after],{maxBuffer:1024*1024});
  const rows=String(stdout).split(/\r?\n/).filter(Boolean);
  if(rows.length!==1)throw new Error("broker push must contain exactly one path change");
  const [status,...parts]=rows[0].split("\t");
  if(status!=="A"||parts.length!==1)throw new Error("broker push must add exactly one input file");
  brokerTransportIdFromPath(parts[0]);
  return parts[0];
}

async function main(){
  const event=JSON.parse(await fsp.readFile(required(process.env.GITHUB_EVENT_PATH,"GITHUB_EVENT_PATH"),"utf8"));
  const branch=required(process.env.BROKER_BRANCH,"BROKER_BRANCH");
  const baselineBranch=required(process.env.BROKER_BASELINE_BRANCH,"BROKER_BASELINE_BRANCH");
  if(event?.ref!==`refs/heads/${branch}`)throw new Error("broker push branch is invalid");
  const before=sha(event?.before,"push before SHA"),after=sha(event?.after,"push after SHA");
  if(/^0+$/.test(before))throw new Error("broker branch-creation push is not executable");
  const inputPath=await changedInputPath(before,after);
  const transportId=brokerTransportIdFromPath(inputPath);
  const envelope=parseBrokerEnvelope(await fsp.readFile(inputPath));
  const inputKey=unwrapAesKey(required(process.env.AGENTIC_INPUT_UNWRAP_PRIVATE_KEY_PEM,"input unwrap private key"),envelope.wrapped_input_key);
  const input=normalizeBrokerInput(openBrokerInput(transportId,envelope.input_capsule,inputKey),RUNNERS[envelope.runner_label]);
  if(input.runner.label!==envelope.runner_label)throw new Error("broker runner mismatch");

  const acceptedMs=Date.now();
  await writeBrokerRetentionRecord({
    repository:required(process.env.GITHUB_REPOSITORY,"GITHUB_REPOSITORY"),
    token:required(process.env.GITHUB_TOKEN,"GITHUB_TOKEN"),
    record:{
      v:1,
      transport_id:transportId,
      runner_label:envelope.runner_label,
      branch,
      baseline_branch:baselineBranch,
      accepted_at:new Date(acceptedMs).toISOString(),
      expires_at:new Date(acceptedMs+BROKER_RETENTION_MS).toISOString(),
    },
  });

  const active=(await listBrokerRetentionRecords({
    repository:required(process.env.GITHUB_REPOSITORY,"GITHUB_REPOSITORY"),
    token:required(process.env.GITHUB_TOKEN,"GITHUB_TOKEN"),
  })).filter(record=>record.expires_ms>acceptedMs).length;
  const output=required(process.env.GITHUB_OUTPUT,"GITHUB_OUTPUT");
  fs.appendFileSync(output,`runner_label=${envelope.runner_label}\ntransport_id=${transportId}\ninput_path=${inputPath}\nactive_jobs=${Math.max(1,active)}\n`);
  console.log("broker_request_accepted");
}
main().catch(()=>{console.error("broker_request_rejected");process.exitCode=1;});
