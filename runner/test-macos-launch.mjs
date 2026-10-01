import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {execFileSync} from 'node:child_process';
import {MacCandidateSupervisor} from './macos-supervisor.mjs';
import {candidateSourceOwner} from './source-materializer.mjs';
test('Darwin source owner matches the candidate account, Linux numeric ownership stays stable',()=>{
 assert.equal(candidateSourceOwner('darwin'),'nobody:nobody');assert.equal(candidateSourceOwner('linux'),'65534:65534');
});
test('controller launches outside candidate cwd; identity change precedes a literal-safe cwd shim',async()=>{
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'launch-test-'));
 let launch;
 const sup=new MacCandidateSupervisor({command:async()=>({stdout:''}),spawnImpl:(exe,args,options)=>{
  launch={exe,args,options};const child=new EventEmitter();child.pid=99999999;child.kill=()=>{};setImmediate(()=>child.emit('close',0,null));return child;
 }});sup.preflight=async()=>{};
 let r;
 try {
  r=await sup.run({workspace,validation_plan:{steps:[{step_id:'quoted-args',argv:['/usr/bin/printf','%s','literal $(touch /tmp/unwanted)'],cwd:'.',timeout_seconds:1}]}});
  assert.equal(r.result.outcome,'passed');assert.equal(launch.options.cwd,'/tmp');
  assert.deepEqual(launch.args.slice(0,4),['-n','-u','nobody','/usr/bin/env']);
  const at=launch.args.indexOf('/bin/sh');assert.equal(launch.args[at+2],'cd -- "$1" && shift && exec "$@"');
  assert.deepEqual(launch.args.slice(at+3),['candidate',workspace,'/usr/bin/printf','%s','literal $(touch /tmp/unwanted)']);
  const actual=execFileSync('/bin/sh',launch.args.slice(at+1),{encoding:'utf8'});assert.equal(actual,'literal $(touch /tmp/unwanted)');
 } finally {await r?.cleanup();await fs.rm(workspace,{recursive:true,force:true});}
});
test('spawn failure clears its deadline timer and reports the failure promptly',async()=>{
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'launch-test-'));
 const realSet=globalThis.setTimeout,realClear=globalThis.clearTimeout;const active=new Set();
 globalThis.setTimeout=(fn,ms,...args)=>{const h=realSet(fn,ms,...args);active.add(h);return h;};
 globalThis.clearTimeout=h=>{active.delete(h);return realClear(h);};
 const sup=new MacCandidateSupervisor({command:async()=>({stdout:''}),spawnImpl:()=>{
  const child=new EventEmitter();child.pid=99999999;child.kill=()=>{};setImmediate(()=>child.emit('error',Object.assign(new Error('inaccessible cwd'),{code:'EACCES'})));return child;
 }});sup.preflight=async()=>{};
 try{await assert.rejects(sup.run({workspace,validation_plan:{steps:[{step_id:'failed-spawn',argv:['/usr/bin/true'],timeout_seconds:360}]}}),/inaccessible cwd/);assert.equal(active.size,0);}
 finally{for(const h of active)realClear(h);globalThis.setTimeout=realSet;globalThis.clearTimeout=realClear;await fs.rm(workspace,{recursive:true,force:true});}
});
