import fs from "node:fs";
import { parseOuterRequest } from "./request.mjs";
try{
  const req=parseOuterRequest(process.env.REQUEST_JSON||"",process.env.REQUEST_TITLE||"");
  const out=process.env.GITHUB_OUTPUT;
  if(!out)throw new Error("GITHUB_OUTPUT is unavailable");
  fs.appendFileSync(out,`runner_label=${req.runner_label}\njob_id=${req.job_id}\n`);
  console.log("request_accepted");
}catch{
  console.error("request_rejected");
  process.exitCode=1;
}
