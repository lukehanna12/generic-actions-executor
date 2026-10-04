import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, hkdfSync, createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restrictWindowsTree } from "./windows-acl.mjs";

const execFileAsync=promisify(execFile);
const FRAME_MAGIC=Buffer.from([0x47,0x41,0x58,0x34,0x4f,0x55,0x54,0x00]);
const NONCE_BYTES=12;
const TAG_BYTES=16;
const FRAME_BUCKETS=Object.freeze([
  4*1024,
  16*1024,
  64*1024,
  256*1024,
  1024*1024,
  4*1024*1024,
  16*1024*1024,
]);
const MAX_BATCH_JSON=12*1024*1024;
const TRANSPORT_RE=/^q4_[A-Za-z0-9_-]{24,80}$/;

function transport(value){
  if(typeof value!=="string"||!TRANSPORT_RE.test(value))throw new Error("broker transport_id is invalid");
  return value;
}
function key(value){
  if(typeof value!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(value))throw new Error("broker stream key source is invalid");
  const raw=Buffer.from(value,"base64url");
  if(raw.length!==32||raw.toString("base64url")!==value)throw new Error("broker stream key source encoding is invalid");
  return raw;
}
function outputKey(encodedKey,id){
  const salt=createHash("sha256").update(transport(id),"utf8").digest();
  return Buffer.from(hkdfSync("sha256",key(encodedKey),salt,Buffer.from("generic-actions-executor|broker-output-v1","utf8"),32));
}
function frameAad(id,sequence,bucket){
  return Buffer.from(`generic-actions-executor|broker-output-v1|${transport(id)}|${sequence}|${bucket}`,"utf8");
}
function bucketFor(length){
  const minimum=FRAME_MAGIC.length+NONCE_BYTES+TAG_BYTES+4+length;
  const bucket=FRAME_BUCKETS.find(x=>x>=minimum);
  if(!bucket)throw new Error("broker output frame exceeds size ceiling");
  return bucket;
}
function safeSequence(value){
  if(!Number.isSafeInteger(value)||value<1||value>999999999)throw new Error("broker output sequence is invalid");
  return value;
}
function credential(value){
  if(typeof value!=="string"||!value)throw new Error("GITHUB_TOKEN is unavailable");
  return value;
}
function repoUrl(repository){
  if(typeof repository!=="string"||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))throw new Error("GITHUB_REPOSITORY is invalid");
  return `https://github.com/${repository}.git`;
}
function branchName(value){
  if(typeof value!=="string"||!value||value.length>255||/[\x00-\x20~^:?*[\]\\]/.test(value)||value.includes(".."))throw new Error("broker branch is invalid");
  return value;
}

export function sealBrokerFrame(transportId,sequence,events,encodedKey,randomBytes=size=>nodeRandomBytes(size)){
  transport(transportId);safeSequence(sequence);
  if(!Array.isArray(events)||events.length<1)throw new Error("broker output events are invalid");
  const clear=Buffer.from(JSON.stringify({v:1,sequence,events}),"utf8");
  const bucket=bucketFor(clear.length);
  const plaintext=Buffer.alloc(bucket-FRAME_MAGIC.length-NONCE_BYTES-TAG_BYTES);
  plaintext.writeUInt32BE(clear.length,0);
  clear.copy(plaintext,4);
  const iv=Buffer.from(randomBytes(NONCE_BYTES));
  if(iv.length!==NONCE_BYTES)throw new Error("broker output nonce source is invalid");
  const cipher=createCipheriv("aes-256-gcm",outputKey(encodedKey,transportId),iv);
  cipher.setAAD(frameAad(transportId,sequence,bucket));
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  const tag=cipher.getAuthTag();
  const frame=Buffer.alloc(bucket);
  FRAME_MAGIC.copy(frame,0);
  iv.copy(frame,FRAME_MAGIC.length);
  ciphertext.copy(frame,FRAME_MAGIC.length+NONCE_BYTES);
  tag.copy(frame,bucket-TAG_BYTES);
  return frame;
}

export function openBrokerFrame(transportId,sequence,value,encodedKey){
  transport(transportId);safeSequence(sequence);
  const frame=Buffer.isBuffer(value)?value:Buffer.from(value);
  if(!FRAME_BUCKETS.includes(frame.length))throw new Error("broker output frame bucket is invalid");
  if(!frame.subarray(0,FRAME_MAGIC.length).equals(FRAME_MAGIC))throw new Error("broker output frame magic is invalid");
  const iv=frame.subarray(FRAME_MAGIC.length,FRAME_MAGIC.length+NONCE_BYTES);
  const body=frame.subarray(FRAME_MAGIC.length+NONCE_BYTES,frame.length-TAG_BYTES);
  const tag=frame.subarray(frame.length-TAG_BYTES);
  const decipher=createDecipheriv("aes-256-gcm",outputKey(encodedKey,transportId),iv);
  decipher.setAAD(frameAad(transportId,sequence,frame.length));
  decipher.setAuthTag(tag);
  const clear=Buffer.concat([decipher.update(body),decipher.final()]);
  if(clear.length<4)throw new Error("broker output cleartext is truncated");
  const length=clear.readUInt32BE(0);
  if(length<2||length>clear.length-4)throw new Error("broker output cleartext length is invalid");
  if(clear.subarray(4+length).some(x=>x!==0))throw new Error("broker output padding is invalid");
  const parsed=JSON.parse(clear.subarray(4,4+length).toString("utf8"));
  if(parsed?.v!==1||parsed?.sequence!==sequence||!Array.isArray(parsed?.events))throw new Error("broker output frame payload is invalid");
  return parsed;
}

export class GitOutputWriter{
  constructor({repository,branch,token,command=execFileAsync,fsImpl=fs,tempRoot=process.env.RUNNER_TEMP||os.tmpdir()}={}){
    this.repository=repository;this.branch=branchName(branch);this.token=credential(token);this.command=command;this.fs=fsImpl;
    this.root=path.join(tempRoot,`gax-out-${process.pid}-${Date.now()}`);
    this.credentialPath=path.join(this.root,".git-credentials");
    this.initialized=false;
  }
  async init(){
    if(this.initialized)return;
    await this.fs.mkdir(this.root,{recursive:true,mode:0o700});
    if(process.platform==="win32")await restrictWindowsTree(this.root);else await this.fs.chmod(this.root,0o700);
    const encodedToken=encodeURIComponent(this.token);
    await this.fs.writeFile(this.credentialPath,`https://x-access-token:${encodedToken}@github.com\n`,{mode:0o600});
    await this.command("git",["init","-q"],{cwd:this.root});
    await this.command("git",["remote","add","origin",repoUrl(this.repository)],{cwd:this.root});
    this.initialized=true;
  }
  async write(relativePath,bytes){
    if(typeof relativePath!=="string"||!/^out\/q4_[A-Za-z0-9_-]{24,80}\/[0-9]{9}\.bin$/.test(relativePath))
      throw new Error("broker output path is invalid");
    const payload=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);
    await this.init();
    const auth=["-c","credential.helper=","-c",`credential.helper=store --file=${this.credentialPath}`];
    const gitEnv={
      PATH:process.env.PATH||"",
      HOME:this.root,
      GIT_TERMINAL_PROMPT:"0",
      ...(process.platform==="win32"?{
        SystemRoot:process.env.SystemRoot||process.env.WINDIR||"C:\\Windows",
        WINDIR:process.env.WINDIR||process.env.SystemRoot||"C:\\Windows",
        COMSPEC:process.env.COMSPEC||"C:\\Windows\\System32\\cmd.exe",
        PATHEXT:process.env.PATHEXT||".COM;.EXE;.BAT;.CMD",
      }:{LANG:"C.UTF-8",LC_ALL:"C.UTF-8"}),
    };
    for(let attempt=0;attempt<10;attempt++){
      await this.command("git",[...auth,"fetch","-q","--depth=1","origin",this.branch],{cwd:this.root,env:gitEnv,maxBuffer:4*1024*1024});
      await this.command("git",["checkout","-q","-B",this.branch,"FETCH_HEAD"],{cwd:this.root,env:gitEnv});
      const target=path.join(this.root,...relativePath.split("/"));
      await this.fs.mkdir(path.dirname(target),{recursive:true});
      await this.fs.writeFile(target,payload,{mode:0o600});
      await this.command("git",["add","--",relativePath],{cwd:this.root,env:gitEnv});
      await this.command("git",[
        "-c","user.name=github-actions[bot]",
        "-c","user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "commit","-q","-m","executor: output",
      ],{cwd:this.root,env:gitEnv});
      try{
        await this.command("git",[...auth,"push","-q","origin",`HEAD:${this.branch}`],{cwd:this.root,env:gitEnv,maxBuffer:4*1024*1024});
        return;
      }catch(error){
        if(attempt===9)throw new Error("broker output push failed");
        await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
      }
    }
  }
  async purge(){await this.fs.rm(this.root,{recursive:true,force:true}).catch(()=>{});}
}

export class BrokerOutputSink{
  constructor({transportId,inputKey,writer,intervalMs=30000,now=()=>Date.now()}={}){
    this.transportId=transport(transportId);
    this.inputKey=inputKey;
    this.writer=writer;
    this.intervalMs=Math.max(10000,Math.min(Number(intervalMs)||30000,300000));
    this.now=now;
    this.lastFlush=0;
    this.sequence=0;
    this.events=[];
    this.bytes=2;
    this.chain=Promise.resolve();
  }
  async emit(event,{flush=false}={}){
    const encoded=Buffer.from(JSON.stringify(event),"utf8");
    if(encoded.length>MAX_BATCH_JSON)throw new Error("broker output event is too large");
    if(this.events.length&&this.bytes+encoded.length+1>MAX_BATCH_JSON)await this.flush();
    this.events.push(event);this.bytes+=encoded.length+1;
    if(flush||this.now()-this.lastFlush>=this.intervalMs)await this.flush();
  }
  async flush(){
    if(!this.events.length)return;
    const events=this.events;this.events=[];this.bytes=2;
    const sequence=++this.sequence;
    const frame=sealBrokerFrame(this.transportId,sequence,events,this.inputKey);
    const outputPath=`out/${this.transportId}/${String(sequence).padStart(9,"0")}.bin`;
    this.chain=this.chain.then(()=>this.writer.write(outputPath,frame));
    await this.chain;
    this.lastFlush=this.now();
  }
  async close(){await this.flush();await this.chain;await this.writer.purge?.();}
}

export const BROKER_FRAME_BUCKETS=FRAME_BUCKETS;
