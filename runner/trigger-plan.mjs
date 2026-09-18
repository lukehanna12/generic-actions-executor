import fs from "node:fs";
import { parseTriggerRequest } from "./trigger-request.mjs";

try {
  const request=parseTriggerRequest(
    process.env.REQUEST_JSON||"",
    process.env.REQUEST_TITLE||"",
  );
  const output=process.env.GITHUB_OUTPUT;
  if(!output)throw new Error("GITHUB_OUTPUT is unavailable");
  fs.appendFileSync(
    output,
    `runner_label=${request.runner_label}\njob_id=${request.job_id}\n`,
  );
  console.log("request_accepted");
} catch {
  console.error("request_rejected");
  process.exitCode=1;
}
