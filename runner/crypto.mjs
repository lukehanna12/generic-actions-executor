import { Buffer } from "node:buffer";

const NONCE_BYTES = 12;
const RESULT_BUCKET_BYTES = Object.freeze([
  64 * 1024,
  256 * 1024,
  1024 * 1024,
  4 * 1024 * 1024,
  16 * 1024 * 1024,
]);
const RESULT_MAGIC = new TextEncoder().encode("COLRSLT2");
const INPUT_MAGIC = new TextEncoder().encode("COLINP1");
const INPUT_BUCKET_BYTES = Object.freeze([4 * 1024, 16 * 1024, 32 * 1024]);
const RESULT_MAX_BYTES = RESULT_BUCKET_BYTES.at(-1) - RESULT_MAGIC.byteLength - NONCE_BYTES - 16 - 4;

function key(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new Error("runner key must be 256-bit base64url");
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function jobId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(value))
    throw new Error("runner job_id is invalid");
  return value;
}

function decode(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error(`${label} must be base64url`);
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function aad(job, purpose) {
  return new TextEncoder().encode(`executor-crypto-v1|${jobId(job)}|${purpose}`);
}

function resultAad(job, bucket) {
  jobId(job);
  if (!RESULT_BUCKET_BYTES.includes(bucket))
    throw new Error("runner result bucket is invalid");
  return new TextEncoder().encode(`executor-crypto-v2|${job}|result-capsule|${bucket}`);
}

async function aes(raw, usages) {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usages);
}

function resultBucketFor(length) {
  if (!Number.isSafeInteger(length) || length < 1 || length > RESULT_MAX_BYTES)
    throw new Error("runner result exceeds padded capsule ceiling");
  const minimum = RESULT_MAGIC.byteLength + NONCE_BYTES + 16 + 4 + length;
  const bucket = RESULT_BUCKET_BYTES.find(size => size >= minimum);
  if (!bucket) throw new Error("runner result exceeds padded capsule ceiling");
  return bucket;
}

export async function openInput(job, envelope, encodedKey) {
  if (typeof envelope === "string") {
    const capsule = decode(envelope, "runner stateless input capsule");
    if (!INPUT_BUCKET_BYTES.includes(capsule.byteLength))
      throw new Error("runner stateless input capsule bucket is invalid");
    for (let i = 0; i < INPUT_MAGIC.byteLength; i += 1)
      if (capsule[i] !== INPUT_MAGIC[i])
        throw new Error("runner stateless input capsule magic is invalid");
    const ivStart = INPUT_MAGIC.byteLength;
    const iv = capsule.slice(ivStart, ivStart + NONCE_BYTES);
    const ciphertext = capsule.slice(ivStart + NONCE_BYTES);
    const clear = new Uint8Array(await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(`stateless-executor-input-v1|${jobId(job)}|${capsule.byteLength}`),
      tagLength: 128,
    }, await aes(key(encodedKey), ["decrypt"]), ciphertext));
    if (clear.byteLength < 4)
      throw new Error("runner stateless input capsule is truncated");
    const length = new DataView(clear.buffer, clear.byteOffset, clear.byteLength).getUint32(0, false);
    if (length < 1 || length > clear.byteLength - 4)
      throw new Error("runner stateless input length is invalid");
    if (clear.slice(4 + length).some(byte => byte !== 0))
      throw new Error("runner stateless input padding is invalid");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clear.slice(4, 4 + length)));
  }
  if (!envelope || envelope.v !== 1)
    throw new Error("runner input envelope version is unsupported");
  const iv = decode(envelope.nonce, "runner input nonce");
  if (iv.byteLength !== 12) throw new Error("runner input nonce length is invalid");
  const clear = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv,
    additionalData: aad(job, "input-capsule"),
    tagLength: 128,
  }, await aes(key(encodedKey), ["decrypt"]), decode(envelope.ciphertext, "runner input ciphertext"));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clear));
}

export async function sealResult(job, result, encodedKey, randomBytes = size => crypto.getRandomValues(new Uint8Array(size))) {
  const clear = new TextEncoder().encode(JSON.stringify(result));
  const bucket = resultBucketFor(clear.byteLength);
  const plaintext = new Uint8Array(bucket - RESULT_MAGIC.byteLength - NONCE_BYTES - 16);
  new DataView(plaintext.buffer).setUint32(0, clear.byteLength, false);
  plaintext.set(clear, 4);
  const iv = randomBytes(NONCE_BYTES);
  if (!(iv instanceof Uint8Array) || iv.byteLength !== NONCE_BYTES)
    throw new Error("runner result nonce source is invalid");
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv,
    additionalData: resultAad(job, bucket),
    tagLength: 128,
  }, await aes(key(encodedKey), ["encrypt"]), plaintext));
  const capsule = new Uint8Array(bucket);
  capsule.set(RESULT_MAGIC, 0);
  capsule.set(iv, RESULT_MAGIC.byteLength);
  capsule.set(ciphertext, RESULT_MAGIC.byteLength + NONCE_BYTES);
  return capsule;
}

export const RESULT_CAPSULE_BUCKETS = RESULT_BUCKET_BYTES;
