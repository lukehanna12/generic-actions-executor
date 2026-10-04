import fs from "node:fs/promises";
import os from "node:os";
import { brokerTransportIdFromPath, openBrokerInput, parseBrokerEnvelope } from "./broker-envelope.mjs";
import { normalizeBrokerInput } from "./broker-input.mjs";
import { BrokerPayloadMaterializer } from "./broker-materializer.mjs";
import { BrokerOutputSink, GitOutputWriter } from "./broker-output.mjs";
import { RUNNERS, unwrapAesKey } from "./request.mjs";
import { CandidateSupervisorFactory } from "./supervisor-factory.mjs";
import { CandidateEnvironmentEngine } from "./environment-engine.mjs";

let stage="start";
function required(value,label){
  if(typeof value!=="string"||!value)throw new Error(label+" is unavailable");
  return value;
}
function publicPhase(name){
  stage=name;
  console.log(`phase=${name}`);
}
async function hostTelemetry(){
  const memory=process.memoryUsage();
  const usage=process.resourceUsage();
  let disk=null;
  try{
    const stat=await fs.statfs(process.cwd());
    disk={block_size:Number(stat.bsize),blocks:Number(stat.blocks),blocks_free:Number(stat.bfree),blocks_available:Number(stat.bavail)};
  }catch{}
  return {
    kind:"metric",
    name:"executor.host",
    time:new Date().toISOString(),
    attributes:{
      platform:process.platform,
      arch:process.arch,
      node:process.version,
      logical_cpu_count:os.cpus().length,
      load_average:os.loadavg(),
      memory_total_bytes:os.totalmem(),
      memory_free_bytes:os.freemem(),
      process_rss_bytes:memory.rss,
      process_heap_used_bytes:memory.heapUsed,
      process_external_bytes:memory.external,
      process_user_cpu_us:usage.userCPUTime,
      process_system_cpu_us:usage.systemCPUTime,
      process_max_rss_kb:usage.maxRSS,
      process_fs_read:usage.fsRead,
      process_fs_write:usage.fsWrite,
      host_uptime_seconds:os.uptime(),
      runner_name:process.env.RUNNER_NAME||"",
      runner_os:process.env.RUNNER_OS||"",
      runner_arch:process.env.RUNNER_ARCH||"",
      image_os:process.env.ImageOS||"",
      image_version:process.env.ImageVersion||"",
      github_run_id:process.env.GITHUB_RUN_ID||"",
      github_run_attempt:process.env.GITHUB_RUN_ATTEMPT||"",
      disk,
    },
  };
}

async function loadExecution(){
  const inputPath=required(process.env.BROKER_INPUT_PATH,"BROKER_INPUT_PATH");
  const transportId=required(process.env.BROKER_TRANSPORT_ID,"BROKER_TRANSPORT_ID");
  if(brokerTransportIdFromPath(inputPath)!==transportId)throw new Error("broker input path identity mismatch");
  const envelope=parseBrokerEnvelope(await fs.readFile(inputPath));
  const inputKey=unwrapAesKey(required(process.env.AGENTIC_INPUT_UNWRAP_PRIVATE_KEY_PEM,"input unwrap private key"),envelope.wrapped_input_key);
  const input=normalizeBrokerInput(openBrokerInput(transportId,envelope.input_capsule,inputKey),RUNNERS[envelope.runner_label]);
  return Object.freeze({transportId,inputPath,envelope,inputKey,input});
}

async function main(){
  const execution=await loadExecution();
  const githubToken=required(process.env.GITHUB_TOKEN,"GITHUB_TOKEN");
  const activeJobs=Number(process.env.BROKER_ACTIVE_JOBS||"1");
  if(!Number.isSafeInteger(activeJobs)||activeJobs<1||activeJobs>1000)throw new Error("broker active job count is invalid");
  const effectiveIntervalSeconds=Math.min(300,Math.max(execution.input.stream_interval_seconds,activeJobs*10));
  const writer=new GitOutputWriter({
    repository:required(process.env.GITHUB_REPOSITORY,"GITHUB_REPOSITORY"),
    branch:required(process.env.BROKER_BRANCH,"BROKER_BRANCH"),
    token:githubToken,
  });
  delete process.env.GITHUB_TOKEN;
  delete process.env.AGENTIC_INPUT_UNWRAP_PRIVATE_KEY_PEM;
  const sink=new BrokerOutputSink({
    transportId:execution.transportId,
    inputKey:execution.inputKey,
    writer,
    intervalMs:effectiveIntervalSeconds*1000,
  });
  let eventChain=Promise.resolve();
  let eventFailure=null;
  const emit=(event,options={})=>{
    eventChain=eventChain.then(()=>sink.emit(event,options)).catch(error=>{eventFailure=error;});
    return eventChain;
  };
  const phase=async name=>{
    publicPhase(name);
    await emit({kind:"event",name:"executor.phase",time:new Date().toISOString(),attributes:{phase:name}});
  };
  let materialized=null,supervised=null,timer=null;
  try{
    await emit({
      kind:"event",
      name:"executor.accepted",
      time:new Date().toISOString(),
      attributes:{job_id:execution.input.job_id,models:execution.input.models,runner:execution.input.runner,effective_stream_interval_seconds:effectiveIntervalSeconds},
    },{flush:true});
    await phase("input_opened");
    materialized=await new BrokerPayloadMaterializer().materialize(execution.input);
    await phase("workspace_materialized");
    const supervisor=await new CandidateSupervisorFactory().forInput(execution.input.runner);
    await phase("supervisor_selected");
    timer=setInterval(()=>{hostTelemetry().then(event=>emit(event)).catch(()=>{});},effectiveIntervalSeconds*1000);
    const prepared=await new CandidateEnvironmentEngine({miseBin:process.env.MISE_BIN||""}).prepare({
      runner:execution.input.runner,
      environment:execution.input.environment,
      validation_plan:execution.input.validation_plan,
    });
    await phase("environment_prepared");
    supervised=await supervisor.run({workspace:materialized.workspace,validation_plan:prepared});
    await phase("candidate_terminated");
    if(timer){clearInterval(timer);timer=null;}
    await eventChain;
    if(eventFailure)throw eventFailure;
    await emit(await hostTelemetry());
    for(const step of supervised.result.steps){
      await emit({
        kind:"event",
        name:"executor.step_result",
        time:new Date().toISOString(),
        attributes:{
          step_id:step.step_id,
          exit_code:step.exit_code,
          signal:step.signal??null,
          timed_out:Boolean(step.timed_out),
          stdout:step.stdout,
          stderr:step.stderr,
        },
      });
    }
    await emit({
      kind:"event",
      name:"executor.complete",
      time:new Date().toISOString(),
      attributes:{
        job_id:execution.input.job_id,
        outcome:supervised.result.outcome,
        terminated_at:supervised.terminated_at,
        group_id:supervised.group_id,
        step_count:supervised.result.steps.length,
      },
    },{flush:true});
    await eventChain;
    if(eventFailure)throw eventFailure;
    await sink.close();
    publicPhase("output_committed");
  }catch(error){
    if(timer)clearInterval(timer);
    await eventChain.catch(()=>{});
    await emit({
      kind:"event",
      name:"executor.failed",
      time:new Date().toISOString(),
      attributes:{phase:stage},
    },{flush:true}).catch(()=>{});
    await sink.close().catch(()=>{});
    throw error;
  }finally{
    await supervised?.purge?.().catch(()=>{});
    await materialized?.purge?.().catch(()=>{});
    await writer.purge?.().catch(()=>{});
  }
}
main().catch(()=>{console.error(`execution_failed_phase=${stage}`);process.exitCode=1;});
