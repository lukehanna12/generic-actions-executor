import { Buffer } from "node:buffer";
import { constants, createCipheriv, createDecipheriv, publicEncrypt, randomBytes as nodeRandomBytes } from "node:crypto";
import { RUNNERS } from "./request.mjs";

const OUTER_MAGIC=Buffer.from([0x47,0x41,0x58,0x34,0x49,0x4e,0x00,0x00]);
const CAPSULE_MAGIC=Buffer.from([0x47,0x41,0x58,0x34,0x52,0x45,0x51,0x00]);
const HEADER_BYTES=16;
const NONCE_BYTES=12;
const TAG_BYTES=16;
const MAX_FILE_BYTES=96*1024*1024;
const CAPSULE_BUCKETS=Object.freeze([
  4*1024,
  16*1024,
  64*1024,
  256*1024,
  1024*1024,
  4*1024*1024,
  16*1024*1024,
  64*1024*1024,
  95*1024*1024,
]);
const TRANSPORT_RE=/^q4_[A-Za-z0-9_-]{24,80}$/;

function transport(value){
  if(typeof value!=="string"||!TRANSPORT_RE.test(value))throw new Error("broker transport_id is invalid");
  return value;
}
function key(value){
  if(typeof value!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(value))throw new Error("broker key is invalid");
  const raw=Buffer.from(value,"base64url");
  if(raw.length!==32||raw.toString("base64url")!==value)throw new Error("broker key encoding is invalid");
  return raw;
}
function canonicalB64(value,label,min,max){
  if(typeof value!=="string"||!value||!/^[A-Za-z0-9_-]+$/.test(value))throw new Error(label+" is invalid");
  const raw=Buffer.from(value,"base64url");
  if(raw.length<min||raw.length>max||raw.toString("base64url")!==value)throw new Error(label+" encoding is invalid");
  return raw;
}
function assertMagic(raw,magic,label){
  if(raw.length<magic.length||!raw.subarray(0,magic.length).equals(magic))throw new Error(label+" magic is invalid");
}
function aad(id,bucket){
  return Buffer.from(`generic-actions-executor|broker-input-v1|${transport(id)}|${bucket}`,"utf8");
}
function bucketFor(clearBytes){
  const minimum=CAPSULE_MAGIC.length+NONCE_BYTES+TAG_BYTES+4+clearBytes;
  const bucket=CAPSULE_BUCKETS.find(x=>x>=minimum);
  if(!bucket)throw new Error("broker input capsule exceeds size ceiling");
  return bucket;
}

export function brokerTransportIdFromPath(pathname){
  if(typeof pathname!=="string")throw new Error("broker input path is invalid");
  const match=pathname.match(/^in\/(q4_[A-Za-z0-9_-]{24,80})\.bin$/);
  if(!match)throw new Error("broker input path is invalid");
  return match[1];
}

export function parseBrokerEnvelope(value){
  const raw=Buffer.isBuffer(value)?value:Buffer.from(value);
  if(raw.length<HEADER_BYTES+1||raw.length>MAX_FILE_BYTES)throw new Error("broker input file size is invalid");
  assertMagic(raw,OUTER_MAGIC,"broker envelope");
  const labelLength=raw.readUInt8(8);
  const flags=raw.readUInt8(9);
  const wrappedLength=raw.readUInt16BE(10);
  const capsuleLength=raw.readUInt32BE(12);
  if(flags!==0||labelLength<1||labelLength>64||wrappedLength<256||wrappedLength>1024)
    throw new Error("broker envelope header is invalid");
  const expected=HEADER_BYTES+labelLength+wrappedLength+capsuleLength;
  if(expected!==raw.length)throw new Error("broker envelope length is invalid");
  if(!CAPSULE_BUCKETS.includes(capsuleLength))throw new Error("broker capsule bucket is invalid");
  let offset=HEADER_BYTES;
  const runnerLabel=raw.subarray(offset,offset+labelLength).toString("utf8");offset+=labelLength;
  if(!Object.hasOwn(RUNNERS,runnerLabel))throw new Error("broker runner label is not allowed");
  const wrapped=raw.subarray(offset,offset+wrappedLength);offset+=wrappedLength;
  const capsule=raw.subarray(offset,offset+capsuleLength);
  return Object.freeze({
    runner_label:runnerLabel,
    wrapped_input_key:wrapped.toString("base64url"),
    input_capsule:Buffer.from(capsule),
  });
}

export function encodeBrokerEnvelope({runner_label,wrapped_input_key,input_capsule}){
  if(!Object.hasOwn(RUNNERS,runner_label))throw new Error("broker runner label is not allowed");
  const label=Buffer.from(runner_label,"utf8");
  if(label.length<1||label.length>64)throw new Error("broker runner label is invalid");
  const wrapped=canonicalB64(wrapped_input_key,"wrapped input key",256,1024);
  const capsule=Buffer.isBuffer(input_capsule)?input_capsule:Buffer.from(input_capsule);
  if(!CAPSULE_BUCKETS.includes(capsule.length))throw new Error("broker capsule bucket is invalid");
  const raw=Buffer.alloc(HEADER_BYTES+label.length+wrapped.length+capsule.length);
  OUTER_MAGIC.copy(raw,0);
  raw.writeUInt8(label.length,8);
  raw.writeUInt8(0,9);
  raw.writeUInt16BE(wrapped.length,10);
  raw.writeUInt32BE(capsule.length,12);
  let offset=HEADER_BYTES;
  label.copy(raw,offset);offset+=label.length;
  wrapped.copy(raw,offset);offset+=wrapped.length;
  capsule.copy(raw,offset);
  return raw;
}

export function wrapBrokerKey(publicKeyPem,encodedKey){
  const raw=key(encodedKey);
  return publicEncrypt({
    key:publicKeyPem,
    padding:constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash:"sha256",
  },raw).toString("base64url");
}

export function sealBrokerInput(transportId,value,encodedKey,randomBytes=size=>nodeRandomBytes(size)){
  const clear=Buffer.from(JSON.stringify(value),"utf8");
  const bucket=bucketFor(clear.length);
  const plaintext=Buffer.alloc(bucket-CAPSULE_MAGIC.length-NONCE_BYTES-TAG_BYTES);
  plaintext.writeUInt32BE(clear.length,0);
  clear.copy(plaintext,4);
  const iv=Buffer.from(randomBytes(NONCE_BYTES));
  if(iv.length!==NONCE_BYTES)throw new Error("broker nonce source is invalid");
  const cipher=createCipheriv("aes-256-gcm",key(encodedKey),iv);
  cipher.setAAD(aad(transportId,bucket));
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  const tag=cipher.getAuthTag();
  const capsule=Buffer.alloc(bucket);
  CAPSULE_MAGIC.copy(capsule,0);
  iv.copy(capsule,CAPSULE_MAGIC.length);
  ciphertext.copy(capsule,CAPSULE_MAGIC.length+NONCE_BYTES);
  tag.copy(capsule,bucket-TAG_BYTES);
  return capsule;
}

export function openBrokerInput(transportId,value,encodedKey){
  const capsule=Buffer.isBuffer(value)?value:Buffer.from(value);
  if(!CAPSULE_BUCKETS.includes(capsule.length))throw new Error("broker capsule bucket is invalid");
  assertMagic(capsule,CAPSULE_MAGIC,"broker capsule");
  const ivStart=CAPSULE_MAGIC.length;
  const iv=capsule.subarray(ivStart,ivStart+NONCE_BYTES);
  const body=capsule.subarray(ivStart+NONCE_BYTES,capsule.length-TAG_BYTES);
  const tag=capsule.subarray(capsule.length-TAG_BYTES);
  const decipher=createDecipheriv("aes-256-gcm",key(encodedKey),iv);
  decipher.setAAD(aad(transportId,capsule.length));
  decipher.setAuthTag(tag);
  const clear=Buffer.concat([decipher.update(body),decipher.final()]);
  if(clear.length<4)throw new Error("broker input cleartext is truncated");
  const length=clear.readUInt32BE(0);
  if(length<2||length>clear.length-4)throw new Error("broker input cleartext length is invalid");
  if(clear.subarray(4+length).some(x=>x!==0))throw new Error("broker input padding is invalid");
  return JSON.parse(clear.subarray(4,4+length).toString("utf8"));
}

export const BROKER_CAPSULE_BUCKETS=CAPSULE_BUCKETS;
export const BROKER_MAX_FILE_BYTES=MAX_FILE_BYTES;
