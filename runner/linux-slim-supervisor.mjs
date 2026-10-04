import { randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const exec=promisify(execFile);
const MAX=4*1024*1024;
const SAFE="/usr/local/bin:/usr/bin:/bin";
const KILL_GRACE_MS=5000;
const CANDIDATE_UID="65534";

function inside(root,rel){
  const resolved=path.resolve(root,rel||".");
  const prefix=path.resolve(root)+path.sep;
  if(resolved!==path.resolve(root)&&!resolved.startsWith(prefix))throw new Error("candidate cwd escapes private workspace");
  return resolved;
}
async function readBounded(file){const stat=await fs.stat(file);if(stat.size>MAX)throw new Error("candidate output exceeded private capture ceiling");return fs.readFile(file,"utf8");}
function exitPromise(child){return new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>resolve({code,signal}));});}
function forceKill(child){try{process.kill(-child.pid,"SIGKILL");}catch{}try{child.kill("SIGKILL");}catch{}}
async function waitForExit(child,timeoutMs){
  const exited=exitPromise(child);let timer;
  const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve(null),timeoutMs);});
  let first;try{first=await Promise.race([exited,timeout]);}finally{clearTimeout(timer);}
  if(first)return {...first,timed_out:false};
  forceKill(child);let killTimer;
  const after=await Promise.race([exited,new Promise(resolve=>{killTimer=setTimeout(()=>resolve(null),KILL_GRACE_MS);})]);
  clearTimeout(killTimer);if(!after)throw new Error("candidate did not terminate after SIGKILL");return {...after,timed_out:true};
}
async function uidProcesses(){
  const out=new Map();
  for(const name of await fs.readdir("/proc").catch(()=>[])){
    if(!/^\d+$/.test(name))continue;
    try{
      const status=await fs.readFile(`/proc/${name}/status`,"utf8");
      const uid=status.match(/^Uid:\s+(\d+)/m)?.[1];
      if(uid!==CANDIDATE_UID)continue;
      const stat=await fs.readFile(`/proc/${name}/stat`,"utf8");
      const tail=stat.slice(stat.lastIndexOf(") ")+2).trim().split(/\s+/);
      const start=tail[19]||"";
      out.set(Number(name),start);
    }catch{}
  }
  return out;
}
function extras(before,after){return [...after.entries()].filter(([pid,start])=>before.get(pid)!==start).map(([pid])=>pid);}

export class LinuxSlimCandidateSupervisor{
  constructor({spawnImpl=spawn,command=exec,now=()=>new Date().toISOString()}={}){this.spawn=spawnImpl;this.command=command;this.now=now;}
  async preflight(){
    if(process.platform!=="linux")throw new Error("Ubuntu Slim supervisor requires Linux");
    await this.command("/usr/bin/sudo",["-n","/usr/bin/true"]);
    const {stdout}=await this.command("/usr/bin/sudo",["-n","-u","nobody","/usr/bin/id","-u"]);
    if(String(stdout).trim()!==CANDIDATE_UID)throw new Error("Ubuntu Slim nobody identity mismatch");
  }
  async purgeNewNobodyProcesses(before){
    for(let round=0;round<5;round++){
      const after=await uidProcesses();const pids=extras(before,after);
      if(!pids.length)return;
      for(const pid of pids)await this.command("/usr/bin/sudo",["-n","/bin/kill","-KILL",String(pid)]).catch(()=>{});
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    const remaining=extras(before,await uidProcesses());
    if(remaining.length)throw new Error("candidate UID still owns processes after termination");
  }
  async run({workspace,validation_plan}){
    if(!validation_plan||!Array.isArray(validation_plan.steps)||validation_plan.steps.length<1)throw new Error("candidate validation plan is invalid");
    await this.preflight();
    const id=`grp_${randomBytes(18).toString("base64url")}`;
    const home=await fs.mkdtemp("/tmp/generic-slim-home-");
    const capture=await fs.mkdtemp("/tmp/generic-slim-capture-");
    const originalUid=String(process.getuid?.()??1001),originalGid=String(process.getgid?.()??1001);
    await this.command("/usr/bin/sudo",["-n","/bin/chown","-R","65534:65534",workspace]);
    await fs.chmod(home,0o700);
    await this.command("/usr/bin/sudo",["-n","/bin/chown","-R","65534:65534",home]);
    await this.command("/usr/bin/sudo",["-n","-u","nobody","/bin/mkdir","-p",path.join(home,"tmp")]);
    const results=[];
    try{
      for(const step of validation_plan.steps){
        const cwd=inside(workspace,step.cwd||".");
        const stdoutPath=path.join(capture,`${results.length}.out`),stderrPath=path.join(capture,`${results.length}.err`);
        const stdoutHandle=await fs.open(stdoutPath,"w",0o600),stderrHandle=await fs.open(stderrPath,"w",0o600);
        const envArgs=[`PATH=${SAFE}`,`HOME=${home}`,`TMPDIR=${path.join(home,"tmp")}`,"LANG=C.UTF-8","LC_ALL=C.UTF-8","CI=true","TERM=dumb"];
        const argv=Array.isArray(step.argv)?step.argv.map(String):[];if(!argv.length)throw new Error("candidate step argv is empty");
        const before=await uidProcesses();let exit;
        try{
          const child=this.spawn("/usr/bin/sudo",["-n","-u","nobody","/usr/bin/env","-i",...envArgs,...argv],{cwd,detached:true,stdio:["ignore",stdoutHandle.fd,stderrHandle.fd],env:{PATH:SAFE}});
          exit=await waitForExit(child,Math.min(Number(step.timeout_seconds||900)*1000,3600000));
        }finally{await stdoutHandle.close();await stderrHandle.close();}
        await this.purgeNewNobodyProcesses(before);
        results.push({step_id:String(step.step_id),exit_code:Number.isInteger(exit.code)?exit.code:null,signal:exit.signal||null,timed_out:Boolean(exit.timed_out),stdout:await readBounded(stdoutPath),stderr:await readBounded(stderrPath)});
      }
    }finally{
      await this.command("/usr/bin/sudo",["-n","/bin/chown","-R",`${originalUid}:${originalGid}`,workspace]).catch(()=>{});
    }
    return Object.freeze({group_id:id,terminated_at:this.now(),result:Object.freeze({outcome:results.every(x=>x.exit_code===0&&!x.timed_out)?"passed":"failed",steps:Object.freeze(results)}),cleanup:async()=>{await Promise.all([fs.rm(home,{recursive:true,force:true}),fs.rm(capture,{recursive:true,force:true})]);}});
  }
}
