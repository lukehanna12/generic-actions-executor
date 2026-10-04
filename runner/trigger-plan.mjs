import fs from "node:fs";
import { parseTriggerRequest } from "./trigger-request.mjs";
import { listRetentionRecords, RETENTION_MS, writeRetentionRecord } from "./retention-ledger.mjs";

const API=process.env.GITHUB_API_URL||"https://api.github.com";
const GRAPHQL=process.env.GITHUB_GRAPHQL_URL||"https://api.github.com/graphql";

function required(value,label){
  if(typeof value!=="string"||!value)throw new Error(label+" is unavailable");
  return value;
}

function issueHeaders(token){
  return {
    Accept:"application/vnd.github+json",
    Authorization:`Bearer ${token}`,
    "X-GitHub-Api-Version":"2026-03-10",
    "User-Agent":"generic-executor-issue-purge",
  };
}

async function deleteAcceptedIssue(issueId,token){
  const response=await fetch(GRAPHQL,{
    method:"POST",
    headers:{...issueHeaders(token),"Content-Type":"application/json"},
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

async function listRepositoryIssues(repository,token){
  const [owner,name]=repository.split("/");
  if(!owner||!name)throw new Error("repository identity is invalid");
  const out=[];
  for(let page=1;page<=100;page++){
    const response=await fetch(
      `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues?state=all&per_page=100&page=${page}`,
      {headers:issueHeaders(token)},
    );
    const rows=await response.json().catch(()=>null);
    if(!response.ok||!Array.isArray(rows))
      throw new Error("issue backlog listing failed");
    out.push(...rows);
    if(rows.length<100)break;
  }
  return out;
}

async function deleteIssueBatch(rows,token){
  if(rows.length===0)return;
  const declarations=rows.map((_,i)=>`$id${i}:ID!`).join(",");
  const selections=rows.map((_,i)=>
    `d${i}:deleteIssue(input:{issueId:$id${i}}){repository{id}}`
  ).join(" ");
  const variables=Object.fromEntries(rows.map((row,i)=>[`id${i}`,row.node_id]));
  const response=await fetch(GRAPHQL,{
    method:"POST",
    headers:{...issueHeaders(token),"Content-Type":"application/json"},
    body:JSON.stringify({
      query:`mutation(${declarations}){${selections}}`,
      variables,
    }),
  });
  const body=await response.json().catch(()=>null);
  if(!response.ok||!body||Array.isArray(body.errors)&&body.errors.length)
    throw new Error("retained trigger backlog deletion failed");
  for(let i=0;i<rows.length;i++){
    if(typeof body?.data?.[`d${i}`]?.repository?.id!=="string")
      throw new Error("retained trigger backlog deletion response is invalid");
  }
}

async function purgeRetainedTriggerBacklog(repository,ledgerToken,issueToken){
  const records=await listRetentionRecords({repository,token:ledgerToken});
  const retained=new Set(records.map(record=>record.job_id));
  const owner=repository.split("/")[0];
  const issues=await listRepositoryIssues(repository,issueToken);
  const targets=issues.filter(issue=>
    !issue.pull_request&&
    issue?.user?.login===owner&&
    retained.has(issue.title)&&
    typeof issue.node_id==="string"
  );
  for(let i=0;i<targets.length;i+=20)
    await deleteIssueBatch(targets.slice(i,i+20),issueToken);
  console.log(`retained_trigger_backlog_purged count=${targets.length}`);
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
  await purgeRetainedTriggerBacklog(repository,token,issuePurgeToken);

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
