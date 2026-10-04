import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec=promisify(execFile);
const SYSTEM_ROOT=process.env.SystemRoot||process.env.WINDIR||"C:\\Windows";
const ICACLS=path.join(SYSTEM_ROOT,"System32","icacls.exe");
const WHOAMI=path.join(SYSTEM_ROOT,"System32","whoami.exe");

async function controllerSid(){
  const {stdout}=await exec(WHOAMI,["/user","/fo","csv","/nh"],{windowsHide:true,maxBuffer:1024*1024});
  const matches=[...String(stdout).matchAll(/"([^"]*)"/g)].map(x=>x[1]);
  const sid=matches.find(x=>/^S-1-\d+(?:-\d+)+$/.test(x));
  if(!sid)throw new Error("controller Windows SID is unavailable");
  return sid;
}
export async function restrictWindowsTree(pathname){
  if(process.platform!=="win32")return;
  const sid=await controllerSid();
  await exec(ICACLS,[pathname,"/inheritance:r","/grant:r",`*${sid}:(OI)(CI)F`,`*S-1-5-18:(OI)(CI)F`,"/T","/C","/Q"],{windowsHide:true,maxBuffer:4*1024*1024});
}
