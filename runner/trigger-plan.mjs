import fs from "node:fs";
import { parseTriggerRequest } from "./trigger-request.mjs";
import { RETENTION_MS, writeRetentionRecord } from "./retention-ledger.mjs";

const GRAPHQL=process.env.GITHUB_GRAPHQL_URL||"https://api.github.com/graphql";

const RETIRED_ISSUE_IDS=Object.freeze([
  "I_kwDOUdOAIc8AAAABR8gOZQ",
  "I_kwDOUdOAIc8AAAABR86qEg",
  "I_kwDOUdOAIc8AAAABR87-wA",
  "I_kwDOUdOAIc8AAAABR89jTw",
  "I_kwDOUdOAIc8AAAABR9J6Fg",
  "I_kwDOUdOAIc8AAAABUe4hNQ",
  "I_kwDOUdOAIc8AAAABU9MZCA",
]);

function required(value,label){
  if(typeof value!=="string"||!value)throw new Error(label+" is unavailable");
  return value;
}

async function deleteAcceptedIssue(issueId,token){
  const response=await fetch(GRAPHQL,{
    method:"POST",
    headers:{
      Accept:"application/vnd.github+json",
      Authorization:`Bearer ${token}`,
      "Content-Type":"application/json",
      "X-GitHub-Api-Version":"2026-03-10",
      "User-Agent":"generic-executor-issue-purge",
    },
    body:JSON.stringify({
      query:"mutation($id:ID!){deleteIssue(input:{issueId:$id}){repository{id}}}",
      variables:{id:issueId},
    }),
  });
  const body=await response.json().catch(()=>null);
  if(!response.ok||!body||Array.isArray(body.errors)&&body.errors.length)
    throw new Error("accepted issue deletion failed");
  if(typeof body?.data?.deleteIssue?.repository?.id!=="string")
    throw new Error("accepted issue deletion response is invalid");
}

try{
  const request=parseTriggerRequest(
    process.env.REQUEST_JSON||"",
    process.env.REQUEST_TITLE||"",
  );
  const repository=required(process.env.GITHUB_REPOSITORY,"GITHUB_REPOSITORY");
  const token=required(process.env.GITHUB_TOKEN,"GITHUB_TOKEN");
  const issueNodeId=required(process.env.REQUEST_NODE_ID,"issue node ID");
  const issuePurgeToken=required(process.env.ISSUE_PURGE_TOKEN,"ISSUE_PURGE_TOKEN");

  const acceptedMs=Date.now();
  const acceptedAt=new Date(acceptedMs).toISOString();
  const expiresAt=new Date(acceptedMs+RETENTION_MS).toISOString();

  await writeRetentionRecord({
    repository,
    token,
    record:{
      v:1,
      job_id:request.job_id,
      runner_label:request.runner_label,
      accepted_at:acceptedAt,
      expires_at:expiresAt,
      purge_capsule:request.purge_capsule,
    },
  });

  await deleteAcceptedIssue(issueNodeId,issuePurgeToken);
  for(const retiredIssueId of RETIRED_ISSUE_IDS)
    await deleteAcceptedIssue(retiredIssueId,issuePurgeToken);
  console.log(`retired_issue_artifacts_purged count=${RETIRED_ISSUE_IDS.length}`);

  const output=process.env.GITHUB_OUTPUT;
  if(!output)throw new Error("GITHUB_OUTPUT is unavailable");
  fs.appendFileSync(
    output,
    `runner_label=${request.runner_label}\njob_id=${request.job_id}\n`,
  );
  console.log("request_accepted_and_issue_purged");
}catch{
  console.error("request_rejected");
  process.exitCode=1;
}
