import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  brokerTransportIdFromPath,
  encodeBrokerEnvelope,
  openBrokerInput,
  parseBrokerEnvelope,
  sealBrokerInput,
  wrapBrokerKey,
} from "./broker-envelope.mjs";
import { normalizeBrokerInput } from "./broker-input.mjs";
import { BrokerOutputSink, openBrokerFrame, sealBrokerFrame } from "./broker-output.mjs";
import { parseBrokerRetentionRecord, BROKER_RETENTION_MS } from "./broker-retention.mjs";
import { RUNNERS } from "./request.mjs";

const transport="q4_"+"A".repeat(32);
const job="j4_"+"B".repeat(32);
const aes=randomBytes(32).toString("base64url");
const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:3072});
const privatePem=privateKey.export({type:"pkcs8",format:"pem"});
const publicPem=publicKey.export({type:"spki",format:"pem"});
const clear={
  v:4,
  job_id:job,
  models:["m1","m2"],
  runner:RUNNERS["ubuntu-26.04"],
  environment:{toolchains:[],system_packages:[],setup_steps:[]},
  validation_plan:{plan_id:"p",steps:[{step_id:"s",argv:["/bin/true"],cwd:".",timeout_seconds:30}]},
  payload:{secret:"not-public"},
  workspace_archive:"",
  stream_interval_seconds:30,
};
const capsule=sealBrokerInput(transport,clear,aes,size=>Buffer.alloc(size,7));
const wrapped=wrapBrokerKey(publicPem,aes);
const envelopeBytes=encodeBrokerEnvelope({runner_label:"ubuntu-26.04",wrapped_input_key:wrapped,input_capsule:capsule});
assert.equal(envelopeBytes.includes(Buffer.from(job)),false);
assert.equal(envelopeBytes.includes(Buffer.from("not-public")),false);
const envelope=parseBrokerEnvelope(envelopeBytes);
assert.equal(envelope.runner_label,"ubuntu-26.04");
const { privateDecrypt, constants }=await import("node:crypto");
const unwrapped=privateDecrypt({key:privatePem,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},Buffer.from(envelope.wrapped_input_key,"base64url")).toString("base64url");
assert.equal(unwrapped,aes);
const opened=openBrokerInput(transport,envelope.input_capsule,aes);
assert.deepEqual(opened,clear);
const normalized=normalizeBrokerInput(opened,RUNNERS["ubuntu-26.04"]);
assert.equal(normalized.job_id,job);
assert.deepEqual(normalized.models,["m1","m2"]);
assert.equal(brokerTransportIdFromPath(`in/${transport}.bin`),transport);
assert.throws(()=>openBrokerInput("q4_"+"C".repeat(32),envelope.input_capsule,aes));

const event={kind:"event",name:"executor.test",time:"2026-10-04T00:00:00.000Z",attributes:{ok:true}};
const frame=sealBrokerFrame(transport,1,[event],aes,size=>Buffer.alloc(size,9));
assert.deepEqual(openBrokerFrame(transport,1,frame,aes),{v:1,sequence:1,events:[event]});
assert.throws(()=>openBrokerFrame(transport,2,frame,aes));

const writes=[];
const writer={write:async(path,bytes)=>writes.push({path,bytes}),purge:async()=>{}};
let now=1000;
const sink=new BrokerOutputSink({transportId:transport,inputKey:aes,writer,intervalMs:10000,now:()=>now});
await sink.emit(event,{flush:true});
now+=11000;
await sink.emit({...event,name:"executor.test2"});
await sink.close();
assert.equal(writes.length,2);
assert.equal(writes[0].path,`out/${transport}/000000001.bin`);
assert.equal(writes[1].path,`out/${transport}/000000002.bin`);
assert.equal(openBrokerFrame(transport,1,writes[0].bytes,aes).events[0].name,"executor.test");

const accepted="2026-10-04T20:00:00.000Z";
const retained=parseBrokerRetentionRecord({
  v:1,transport_id:transport,runner_label:"ubuntu-26.04",branch:"executor/broker-dev",baseline_branch:"repo-broker-dev",
  accepted_at:accepted,expires_at:new Date(Date.parse(accepted)+BROKER_RETENTION_MS).toISOString(),
});
assert.equal(retained.transport_id,transport);
assert.equal(retained.branch,"executor/broker-dev");
assert.equal(retained.baseline_branch,"repo-broker-dev");
assert.equal(retained.expires_ms-retained.accepted_ms,BROKER_RETENTION_MS);
console.log("broker_protocol_validated");
