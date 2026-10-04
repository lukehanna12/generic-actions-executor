import assert from "node:assert/strict";
import { constants, generateKeyPairSync, publicEncrypt } from "node:crypto";
import { Buffer } from "node:buffer";
import { openPurgeLocator, PURGE_LOCATOR_MAGIC } from "./purge-locator.mjs";
import { parseTriggerRequest } from "./trigger-request.mjs";
import { parseRetentionRecord, RETENTION_MS } from "./retention-ledger.mjs";

const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:3072});
const privatePem=privateKey.export({type:"pkcs8",format:"pem"});
const locator={
  v:1,
  repository_id:123456789,
  baseline_branch:"main",
  source_branch:"workspace",
  source_sha:"a".repeat(40),
  dispatch_branch:"executor/dispatch",
  keys_branch:"agentic/keys",
};
const purgeCapsule=publicEncrypt({
  key:publicKey,
  padding:constants.RSA_PKCS1_OAEP_PADDING,
  oaepHash:"sha256",
},Buffer.concat([PURGE_LOCATOR_MAGIC,Buffer.from(JSON.stringify(locator),"utf8")])).toString("base64url");

assert.deepEqual(openPurgeLocator(privatePem,purgeCapsule),locator);

const job="j2_"+"A".repeat(32);
const trigger=parseTriggerRequest(JSON.stringify({
  v:3,
  job_id:job,
  runner_label:"ubuntu-26.04",
  purge_capsule:purgeCapsule,
}),job);
assert.equal(trigger.v,3);
assert.equal(trigger.job_id,job);
assert.equal(trigger.runner_label,"ubuntu-26.04");
assert.equal(trigger.purge_capsule,purgeCapsule);
assert.throws(()=>parseTriggerRequest(JSON.stringify({
  v:2,
  job_id:job,
  runner_label:"ubuntu-26.04",
  purge_capsule:purgeCapsule,
}),job),/unsupported/);

const accepted="2026-10-04T15:00:00.000Z";
const expires=new Date(Date.parse(accepted)+RETENTION_MS).toISOString();
const retention=parseRetentionRecord({
  v:1,
  job_id:job,
  runner_label:"ubuntu-26.04",
  accepted_at:accepted,
  expires_at:expires,
  purge_capsule:purgeCapsule,
});
assert.equal(retention.job_id,job);
assert.equal(retention.expires_ms-retention.accepted_ms,RETENTION_MS);
assert.equal(retention.purge_capsule,purgeCapsule);

console.log("purge_protocol_validated");
