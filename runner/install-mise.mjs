import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync=promisify(execFile);
const VERSION="2026.9.10";
const ASSETS=Object.freeze({
  "linux-x64":Object.freeze({name:`mise-v${VERSION}-linux-x64`,sha256:"f917e52216924ef0a8b4eca3f7004dfcff3b94665716ac5685fd53006a491eee"}),
  "linux-arm64":Object.freeze({name:`mise-v${VERSION}-linux-arm64`,sha256:"1b46a14314c18f9bbce4bf6f88cc1fb3b31be8dd2b23327a851555f4e144fc61"}),
  "darwin-x64":Object.freeze({name:`mise-v${VERSION}-macos-x64`,sha256:"9a566ce20e984abaf8b02ecca56458f864919fbc979720839956465a5cd28900"}),
  "darwin-arm64":Object.freeze({name:`mise-v${VERSION}-macos-arm64`,sha256:"2d1b5a2a210c172af7d58b017478e0b5d5cdea541916e80a495cd078a92d8706"}),
  "win32-x64":Object.freeze({name:`mise-v${VERSION}-windows-x64.exe`,sha256:"98f2b199c6b283547b66c8ab6d721aab977ff5e084f0e034b71596c7d2aba2e1"}),
  "win32-arm64":Object.freeze({name:`mise-v${VERSION}-windows-arm64.exe`,sha256:"f81de03d8fd293f9401ed083c8b673bfb00404494d11e25fc74cba8224844e77"})
});
const MAX_BYTES=160*1024*1024;

async function download(url,target,expectedHash){
  const response=await fetch(url,{redirect:"follow"});
  if(!response.ok||!response.body)throw new Error(`mise download failed with ${response.status}`);
  const handle=await fs.open(target,"wx",0o600);
  const hash=createHash("sha256");
  let total=0;
  try{
    for await(const chunk of response.body){
      total+=chunk.byteLength;
      if(total>MAX_BYTES)throw new Error("mise download exceeded size ceiling");
      hash.update(chunk);
      await handle.write(chunk);
    }
  }finally{await handle.close();}
  if(total<1024)throw new Error("mise download was unexpectedly small");
  if(hash.digest("hex")!==expectedHash)throw new Error("mise download checksum mismatch");
}

async function main(){
  const key=`${process.platform}-${process.arch}`;
  const asset=ASSETS[key];
  if(!asset)throw new Error(`unsupported mise platform ${key}`);
  const root=path.join(process.env.RUNNER_TEMP||os.tmpdir(),"executor-bin");
  await fs.rm(root,{recursive:true,force:true});
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const name=process.platform==="win32"?"mise.exe":"mise";
  const target=path.join(root,name);
  const url=`https://github.com/jdx/mise/releases/download/v${VERSION}/${asset.name}`;
  await download(url,target,asset.sha256);
  if(process.platform!=="win32")await fs.chmod(target,0o755);
  const {stdout}=await execFileAsync(target,["--version"],{timeout:30000,maxBuffer:1024*1024});
  if(!String(stdout).includes(VERSION))throw new Error("mise version verification failed");
  const output=process.env.GITHUB_OUTPUT;
  if(!output)throw new Error("GITHUB_OUTPUT is unavailable");
  await fs.appendFile(output,`mise_bin=${target}\n`);
  console.log(`mise_ready version=${VERSION} platform=${key}`);
}

main().catch(error=>{
  console.error(`mise_install_failed: ${error.message}`);
  process.exitCode=1;
});
