import { constants, privateDecrypt, createPrivateKey } from "node:crypto";
import { Buffer } from "node:buffer";

export const RUNNERS=Object.freeze({
  "ubuntu-22.04":Object.freeze({provider:"github-hosted",os:"linux",version:"22.04",arch:"x64",label:"ubuntu-22.04"}),
  "ubuntu-22.04-arm":Object.freeze({provider:"github-hosted",os:"linux",version:"22.04",arch:"arm64",label:"ubuntu-22.04-arm"}),
  "ubuntu-24.04":Object.freeze({provider:"github-hosted",os:"linux",version:"24.04",arch:"x64",label:"ubuntu-24.04"}),
  "ubuntu-24.04-arm":Object.freeze({provider:"github-hosted",os:"linux",version:"24.04",arch:"arm64",label:"ubuntu-24.04-arm"}),
  "macos-14":Object.freeze({provider:"github-hosted",os:"macos",version:"14",arch:"arm64",label:"macos-14"}),
  "macos-15":Object.freeze({provider:"github-hosted",os:"macos",version:"15",arch:"arm64",label:"macos-15"}),
  "macos-15-intel":Object.freeze({provider:"github-hosted",os:"macos",version:"15",arch:"x64",label:"macos-15-intel"}),
  "macos-26":Object.freeze({provider:"github-hosted",os:"macos",version:"26",arch:"arm64",label:"macos-26"}),
  "macos-26-intel":Object.freeze({provider:"github-hosted",os:"macos",version:"26",arch:"x64",label:"macos-26-intel"})
});
function text(v,label,max){if(typeof v!=="string"||!v||v.length>max)throw new Error(label+" is invalid");return v;}
function b64(v,label,min=1,max=65536){text(v,label,max);if(!/^[A-Za-z0-9_-]+$/.test(v))throw new Error(label+" must be base64url");const b=Buffer.from(v,"base64url");if(b.length<min||b.length>max||b.toString("base64url")!==v)throw new Error(label+" encoding is invalid");return b;}
export function parseOuterRequest(raw,title){
  if(typeof raw!=="string"||raw.length<100||raw.length>60000)throw new Error("request body size is invalid");
  let v;try{v=JSON.parse(raw);}catch{throw new Error("request body is not JSON");}
  if(!v||typeof v!=="object"||Array.isArray(v))throw new Error("request envelope is invalid");
  const keys=new Set(["v","job_id","runner_label","wrapped_input_key","input_capsule","wrapped_result_key"]);
  for(const k of Object.keys(v))if(!keys.has(k))throw new Error("request contains unknown field");
  if(v.v!==2)throw new Error("request version is unsupported");
  const job=text(v.job_id,"job_id",96);
  if(!/^j2_[A-Za-z0-9_-]{24,80}$/.test(job)||title!==job)throw new Error("job identity is invalid");
  if(!Object.hasOwn(RUNNERS,v.runner_label))throw new Error("runner label is not allowed");
  b64(v.wrapped_input_key,"wrapped_input_key",256,1024);
  b64(v.input_capsule,"input_capsule",4096,50000);
  b64(v.wrapped_result_key,"wrapped_result_key",256,1024);
  return Object.freeze({...v,runner:RUNNERS[v.runner_label]});
}
export function unwrapAesKey(privateKeyPem,wrapped){
  if(typeof privateKeyPem!=="string"||!privateKeyPem.includes("PRIVATE KEY"))throw new Error("unwrap key is unavailable");
  const clear=privateDecrypt({key:createPrivateKey(privateKeyPem),padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},b64(wrapped,"wrapped key",256,1024));
  if(clear.length!==32)throw new Error("unwrapped AES key length is invalid");
  return clear.toString("base64url");
}
