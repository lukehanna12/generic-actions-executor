import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RUNNERS } from "./request.mjs";
import { CandidateSupervisorFactory } from "./supervisor-factory.mjs";

const label=process.env.TEST_RUNNER_LABEL||"";
const mise=process.env.MISE_BIN||"";
const runner=RUNNERS[label];
assert.ok(runner,`unknown TEST_RUNNER_LABEL ${label}`);
assert.ok(mise,"MISE_BIN is required for hosted runner validation");
const factory=new CandidateSupervisorFactory();
const supervisor=await factory.forInput(runner);
const base=process.platform==="win32"?(process.env.RUNNER_TEMP||os.tmpdir()):"/tmp";
const workspace=await fs.mkdtemp(path.join(base,"gax-smoke-workspace-"));
let execution;
try{
  let argv;
  if(runner.os==="windows"){
    const root=process.env.SystemRoot||process.env.WINDIR||"C:\\Windows";
    if(runner.arch==="arm64"){
      argv=[path.join(root,"System32","cmd.exe"),"/d","/c",'start "" /b ping -n 30 127.0.0.1 >NUL & exit /b 0'];
    }else{
      argv=[path.join(root,"System32","whoami.exe")];
    }
  }else if(label==="ubuntu-slim"){
    argv=["/bin/sh","-c","setsid /bin/sleep 30 >/dev/null 2>&1 & exit 0"];
  }else{
    argv=["/usr/bin/printf","%s","runner-smoke"];
  }
  execution=await supervisor.run({
    workspace,
    validation_plan:{
      plan_id:"hosted-runner-smoke",
      steps:[
        {step_id:"mise",argv:[mise,"--version"],cwd:".",timeout_seconds:runner.os==="windows"?120:30},
        {step_id:"smoke",argv,cwd:".",timeout_seconds:30},
      ],
    },
  });
  if(execution.result.outcome!=="passed")console.error(JSON.stringify(execution.result));
  assert.equal(execution.result.outcome,"passed");
  assert.equal(execution.result.steps.length,2);
  assert.equal(execution.result.steps[0].exit_code,0);
  assert.match(execution.result.steps[0].stdout,/2026\.9\.10/);
  assert.equal(execution.result.steps[1].exit_code,0);
  if(runner.os!=="windows"&&label!=="ubuntu-slim")assert.equal(execution.result.steps[1].stdout,"runner-smoke");
  console.log(`hosted_runner_validated label=${label} os=${runner.os} arch=${runner.arch}`);
}finally{
  await execution?.cleanup?.().catch(()=>{});
  await fs.rm(workspace,{recursive:true,force:true}).catch(()=>{});
}
