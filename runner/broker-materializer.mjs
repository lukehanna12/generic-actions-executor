import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restrictWindowsTree } from "./windows-acl.mjs";

const execFileAsync=promisify(execFile);
const MAX_ARCHIVE_BYTES=48*1024*1024;
const MAX_ENTRIES=100000;

function tarBinary(platform=process.platform){
  if(platform!=="win32")return "/usr/bin/tar";
  const root=process.env.SystemRoot||process.env.WINDIR||"C:\\Windows";
  return path.join(root,"System32","tar.exe");
}
function candidateOwner(platform=process.platform){
  if(platform==="darwin")return "nobody:nobody";
  if(platform==="linux")return "65534:65534";
  if(platform==="win32")return null;
  throw new Error("unsupported broker materializer platform");
}
function validateList(text){
  const entries=String(text).split(/\r?\n/).filter(Boolean);
  if(entries.length>MAX_ENTRIES)throw new Error("broker workspace archive has too many entries");
  for(const entry of entries){
    const normalized=entry.replaceAll("\\","/");
    if(/^(?:[A-Za-z]:)?\//.test(normalized)||normalized.split("/").includes(".."))
      throw new Error("broker workspace archive contains an unsafe path");
    if(normalized===".gax"||normalized.startsWith(".gax/"))
      throw new Error("broker workspace archive uses reserved path");
  }
  return entries;
}
async function removeRoot(command,root){
  if(process.platform==="win32"){await fs.rm(root,{recursive:true,force:true});return;}
  await command("/usr/bin/sudo",["-n","/bin/rm","-rf",root]);
}

export class BrokerPayloadMaterializer{
  constructor({commandImpl=execFileAsync,fsImpl=fs}={}){this.command=commandImpl;this.fs=fsImpl;}
  async materialize(input){
    const base=process.platform==="win32"?(process.env.RUNNER_TEMP||os.tmpdir()):"/tmp";
    const root=await this.fs.mkdtemp(path.join(base,"gax-broker-"));
    const workspace=path.join(root,"workspace");
    if(process.platform==="win32")await restrictWindowsTree(root);else await this.fs.chmod(root,0o700);
    await this.fs.mkdir(workspace,{mode:0o700});
    const archivePath=path.join(root,"workspace.tar.gz");
    try{
      if(input.workspace_archive){
        const archive=Buffer.from(input.workspace_archive,"base64url");
        if(archive.length<1||archive.length>MAX_ARCHIVE_BYTES)throw new Error("broker workspace archive size is invalid");
        await this.fs.writeFile(archivePath,archive,{mode:0o600});
        const tar=tarBinary();
        const listed=await this.command(tar,["-tzf",archivePath],{maxBuffer:32*1024*1024});
        validateList(listed.stdout);
        const verbose=await this.command(tar,["-tvzf",archivePath],{maxBuffer:64*1024*1024});
        for(const line of String(verbose.stdout).split(/\r?\n/).filter(Boolean)){
          const type=line[0];
          if(type==="l"||type==="h")throw new Error("broker workspace archive contains a symbolic or hard link");
        }
        const args=process.platform==="win32"
          ?["-xzf",archivePath,"-C",workspace]
          :["-xzf",archivePath,"--no-same-owner","--no-same-permissions","-C",workspace];
        await this.command(tar,args);
        await this.fs.rm(archivePath,{force:true});
      }
      const privateDir=path.join(workspace,".gax");
      await this.fs.mkdir(privateDir,{mode:0o700});
      await this.fs.writeFile(path.join(privateDir,"input.json"),JSON.stringify({
        v:1,
        job_id:input.job_id,
        models:input.models,
        payload:input.payload,
      }),{mode:0o600});
      const owner=candidateOwner();
      if(owner){
        const chown=process.platform==="darwin"?"/usr/sbin/chown":"/bin/chown";
        await this.command("/usr/bin/sudo",["-n",chown,"-R",owner,root]);
        await this.command("/usr/bin/sudo",["-n","/bin/chmod","700",root,workspace]);
      }
      return Object.freeze({
        workspace,
        purge:async()=>removeRoot(this.command,root),
      });
    }catch(error){
      await removeRoot(this.command,root).catch(()=>{});
      throw error;
    }
  }
}
