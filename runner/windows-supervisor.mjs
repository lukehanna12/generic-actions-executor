import { randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { restrictWindowsTree } from "./windows-acl.mjs";

const exec=promisify(execFile);
const MAX=4*1024*1024;
const KILL_GRACE_MS=5000;
const POLL_MS=100;
const SYSTEM_ROOT=process.env.SystemRoot||process.env.WINDIR||"C:\\Windows";
const SYSTEM32=path.join(SYSTEM_ROOT,"System32");
const POWERSHELL=path.join(process.env.ProgramFiles||"C:\\Program Files","PowerShell","7","pwsh.exe");
const NET=path.join(SYSTEM32,"net.exe");
const ICACLS=path.join(SYSTEM32,"icacls.exe");
const TASKKILL=path.join(SYSTEM32,"taskkill.exe");
const SAFE_PATH=[SYSTEM32,SYSTEM_ROOT,path.join(SYSTEM32,"Wbem"),path.dirname(POWERSHELL),path.join(process.env.ProgramData||"C:\\ProgramData","chocolatey","bin")].join(";");
const HERE=path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER=path.join(HERE,"windows-launch.ps1");
const CANDIDATE_SCRIPT=path.join(HERE,"windows-candidate.ps1");

function inside(root,rel){
  const base=path.resolve(root),resolved=path.resolve(root,rel||".");
  const prefix=base.endsWith(path.sep)?base:base+path.sep;
  if(resolved!==base&&!resolved.toLowerCase().startsWith(prefix.toLowerCase()))throw new Error("candidate cwd escapes private workspace");
  return resolved;
}
function userName(){return `gax_${randomBytes(5).toString("hex")}`;}
function password(){return `Gx!${randomBytes(4).toString("hex")}aA1`;}
async function readBounded(file){const stat=await fs.stat(file);if(stat.size>MAX)throw new Error("candidate output exceeded private capture ceiling");return fs.readFile(file,"utf8");}
async function sleep(ms){await new Promise(resolve=>setTimeout(resolve,ms));}
function processExit(child){return new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>resolve({code,signal}));});}
async function fileSize(file){try{return (await fs.stat(file)).size;}catch(error){if(error?.code==="ENOENT")return 0;throw error;}}
function safeEnv(home,username){
  const local=path.join(home,"AppData","Local"),roaming=path.join(home,"AppData","Roaming"),temp=path.join(home,"Temp");
  return Object.freeze({
    PATH:SAFE_PATH,SystemRoot:SYSTEM_ROOT,WINDIR:SYSTEM_ROOT,COMSPEC:path.join(SYSTEM32,"cmd.exe"),PATHEXT:".COM;.EXE;.BAT;.CMD",
    USERPROFILE:home,HOME:home,LOCALAPPDATA:local,APPDATA:roaming,TEMP:temp,TMP:temp,USERNAME:username,
    MISE_DATA_DIR:path.join(local,"mise","data"),MISE_CACHE_DIR:path.join(local,"mise","cache"),MISE_CONFIG_DIR:path.join(local,"mise","config"),MISE_STATE_DIR:path.join(local,"mise","state"),
    CI:"true",TERM:"dumb"
  });
}

export class WindowsCandidateSupervisor{
  constructor({spawnImpl=spawn,command=exec,now=()=>new Date().toISOString()}={}){this.spawn=spawnImpl;this.command=command;this.now=now;}
  async preflight(){
    if(process.platform!=="win32")throw new Error("Windows supervisor requires Windows");
    for(const file of [POWERSHELL,NET,ICACLS,TASKKILL,LAUNCHER,CANDIDATE_SCRIPT])await fs.access(file);
  }
  async createUser(username,secret){
    await this.command(NET,["user",username,secret,"/add","/expires:never","/passwordchg:no"],{windowsHide:true,maxBuffer:1024*1024});
    await this.command(NET,["localgroup","Administrators",username,"/delete"],{windowsHide:true,maxBuffer:1024*1024}).catch(()=>{});
  }
  async deleteUser(username){await this.command(NET,["user",username,"/delete"],{windowsHide:true,maxBuffer:1024*1024}).catch(()=>{});}
  async grant(pathname,username,rights,{inherit=true}={}){
    const ace=`${username}:${inherit?"(OI)(CI)":""}${rights}`;
    const args=[pathname,"/grant:r",ace];
    if(inherit)args.push("/T","/C");
    args.push("/Q");
    await this.command(ICACLS,args,{windowsHide:true,maxBuffer:4*1024*1024});
  }
  async removeGrant(pathname,username){await this.command(ICACLS,[pathname,"/remove",username,"/T","/C","/Q"],{windowsHide:true,maxBuffer:4*1024*1024}).catch(()=>{});}
  async candidatePids(username){
    const escaped=username.replaceAll("'","''");
    const script=`$u='${escaped}';$d=$env:COMPUTERNAME;(Get-CimInstance Win32_Process | ForEach-Object {$o=Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue;if($o.User -eq $u -and $o.Domain -eq $d){$_.ProcessId}}) -join ','`;
    const {stdout}=await this.command(POWERSHELL,["-NoLogo","-NoProfile","-NonInteractive","-Command",script],{windowsHide:true,maxBuffer:1024*1024});
    return String(stdout).trim().split(",").filter(x=>/^\d+$/.test(x)).map(Number);
  }
  async purgeCandidate(username){
    for(let round=0;round<5;round++){
      const pids=await this.candidatePids(username);
      if(!pids.length)return;
      for(const pid of pids)await this.command(TASKKILL,["/PID",String(pid),"/T","/F"],{windowsHide:true,maxBuffer:1024*1024}).catch(()=>{});
      await sleep(150);
    }
    if((await this.candidatePids(username)).length)throw new Error("candidate Windows identity still owns processes after termination");
  }
  async run({workspace,validation_plan}){
    if(!validation_plan||!Array.isArray(validation_plan.steps)||validation_plan.steps.length<1)throw new Error("candidate validation plan is invalid");
    await this.preflight();
    const id=`grp_${randomBytes(18).toString("base64url")}`;
    const root=await fs.mkdtemp(path.join(process.env.RUNNER_TEMP||os.tmpdir(),"gax-win-"));
    await restrictWindowsTree(root);
    const home=path.join(root,"home"),capture=path.join(root,"capture");
    await fs.mkdir(home,{recursive:true});await fs.mkdir(capture,{recursive:true});
    const username=userName(),secret=password();
    const candidateScript=path.join(home,"candidate.ps1");
    const results=[];
    await fs.copyFile(CANDIDATE_SCRIPT,candidateScript);
    await this.createUser(username,secret);
    try{
      await fs.mkdir(path.join(home,"Temp"),{recursive:true});
      await this.grant(root,username,"RX",{inherit:false});
      await this.grant(home,username,"F");
      const workspaceRoot=path.dirname(workspace);
      await this.grant(workspaceRoot,username,"RX",{inherit:false});
      await this.grant(workspace,username,"M");
      for(const step of validation_plan.steps){
        const index=results.length,cwd=inside(workspace,step.cwd||".");
        const argv=Array.isArray(step.argv)?step.argv.map(String):[];if(!argv.length)throw new Error("candidate step argv is empty");
        const commandSpec=path.join(home,`command-${index}.json`),credentialSpec=path.join(capture,`credential-${index}.json`);
        const stdoutPath=path.join(capture,`${index}.out`),stderrPath=path.join(capture,`${index}.err`),pidPath=path.join(capture,`${index}.pid`);
        await fs.writeFile(commandSpec,JSON.stringify({argv,cwd,env:safeEnv(home,username)}),{mode:0o600});
        await fs.writeFile(credentialSpec,JSON.stringify({username,password:secret}),{mode:0o600});
        const launcher=this.spawn(POWERSHELL,["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",LAUNCHER,credentialSpec,commandSpec,candidateScript,stdoutPath,stderrPath,pidPath],{stdio:["ignore","pipe","pipe"],windowsHide:true,env:{SystemRoot:SYSTEM_ROOT,WINDIR:SYSTEM_ROOT,ProgramFiles:process.env.ProgramFiles||"C:\\Program Files",COMPUTERNAME:process.env.COMPUTERNAME||"",PATH:SAFE_PATH}});
        const exited=processExit(launcher);const started=Date.now();let timedOut=false,overflow=false,settled=null;
        while(!settled){
          settled=await Promise.race([exited.then(x=>({type:"exit",value:x})),sleep(POLL_MS).then(()=>null)]);
          if(settled)break;
          const [outSize,errSize]=await Promise.all([fileSize(stdoutPath),fileSize(stderrPath)]);
          if(outSize>MAX||errSize>MAX){overflow=true;break;}
          if(Date.now()-started>=Math.min(Number(step.timeout_seconds||900)*1000,3600000)){timedOut=true;break;}
        }
        if(timedOut||overflow){
          const pid=Number((await fs.readFile(pidPath,"utf8").catch(()=>"0")).trim());
          if(Number.isSafeInteger(pid)&&pid>0)await this.command(TASKKILL,["/PID",String(pid),"/T","/F"],{windowsHide:true,maxBuffer:1024*1024}).catch(()=>{});
          let timer;const after=await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),KILL_GRACE_MS);})]);clearTimeout(timer);
          if(!after){try{launcher.kill("SIGKILL");}catch{};throw new Error("candidate launcher did not terminate after forced Windows process-tree kill");}
          settled={type:"exit",value:after};
        }
        await this.purgeCandidate(username);
        await fs.rm(credentialSpec,{force:true});
        if(overflow)throw new Error("candidate output exceeded private capture ceiling");
        const exit=settled.value;
        results.push({step_id:String(step.step_id),exit_code:Number.isInteger(exit.code)?exit.code:null,signal:exit.signal||null,timed_out:Boolean(timedOut),stdout:await readBounded(stdoutPath),stderr:await readBounded(stderrPath)});
      }
    }finally{
      await this.purgeCandidate(username).catch(()=>{});
      await this.removeGrant(workspace,username);
      await this.removeGrant(path.dirname(workspace),username);
      await this.removeGrant(root,username);
      await this.deleteUser(username);
    }
    return Object.freeze({group_id:id,terminated_at:this.now(),result:Object.freeze({outcome:results.every(x=>x.exit_code===0&&!x.timed_out)?"passed":"failed",steps:Object.freeze(results)}),cleanup:async()=>fs.rm(root,{recursive:true,force:true})});
  }
}
