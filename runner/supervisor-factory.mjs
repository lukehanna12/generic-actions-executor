import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LinuxCandidateSupervisor } from "./linux-supervisor.mjs";
import { LinuxSlimCandidateSupervisor } from "./linux-slim-supervisor.mjs";
import { MacCandidateSupervisor } from "./macos-supervisor.mjs";
import { WindowsCandidateSupervisor } from "./windows-supervisor.mjs";

const exec=promisify(execFile);
function hostArch(){return process.arch==="x64"?"x64":process.arch==="arm64"?"arm64":process.arch;}
async function windowsIdentity(){
  const root=process.env.SystemRoot||process.env.WINDIR||"C:\\Windows";
  const reg=path.join(root,"System32","reg.exe");
  const key="HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
  const read=async name=>{
    const {stdout}=await exec(reg,["query",key,"/v",name],{windowsHide:true,maxBuffer:1024*1024});
    const line=String(stdout).split(/\r?\n/).find(x=>x.includes(name));
    const value=line?.trim().split(/\s{2,}/).at(-1)||"";
    if(!value)throw new Error(`Windows ${name} is unavailable`);
    return value;
  };
  return Object.freeze({installationType:await read("InstallationType"),build:await read("CurrentBuildNumber")});
}
function verifyWindows(runner,identity){
  const server=/server/i.test(identity.installationType);
  if(runner.version==="2022"&&(!server||identity.build!=="20348"))throw new Error("runner Windows Server 2022 version mismatch");
  if(runner.version==="2025"&&(!server||identity.build!=="26100"))throw new Error("runner Windows Server 2025 version mismatch");
  if(runner.version==="11"&&(server||identity.build!=="26200"))throw new Error("runner Windows 11 version mismatch");
}
export class CandidateSupervisorFactory{
  async forInput(runner){
    if(!runner||runner.arch!==hostArch())throw new Error("runner host architecture does not match trusted request");
    if(runner.os==="macos"){
      if(process.platform!=="darwin")throw new Error("runner host OS mismatch");
      const v=(await fs.readFile("/System/Library/CoreServices/SystemVersion.plist","utf8")).match(/<key>ProductVersion<\/key>\s*<string>([^<]+)/)?.[1]||"";
      if(!v.startsWith(`${runner.version}.`))throw new Error("runner macOS version mismatch");
      return new MacCandidateSupervisor();
    }
    if(runner.os==="linux"){
      if(process.platform!=="linux")throw new Error("runner host OS mismatch");
      const t=await fs.readFile("/etc/os-release","utf8"),v=t.match(/^VERSION_ID="?([^"\n]+)"?/m)?.[1]||"";
      if(v!==runner.version)throw new Error("runner Linux version mismatch");
      return runner.label==="ubuntu-slim"?new LinuxSlimCandidateSupervisor():new LinuxCandidateSupervisor();
    }
    if(runner.os==="windows"){
      if(process.platform!=="win32")throw new Error("runner host OS mismatch");
      verifyWindows(runner,await windowsIdentity());
      return new WindowsCandidateSupervisor();
    }
    throw new Error("unsupported runner OS");
  }
}
