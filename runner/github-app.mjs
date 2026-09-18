import { createPrivateKey, sign } from "node:crypto";
import { Buffer } from "node:buffer";
function enc(v){return Buffer.from(JSON.stringify(v),"utf8").toString("base64url");}
export function appJwt({issuer,privateKeyPem,nowMs=Date.now()}={}){
  if(typeof issuer!=="string"||!issuer||typeof privateKeyPem!=="string"||!privateKeyPem.includes("PRIVATE KEY"))throw new Error("GitHub App credentials are invalid");
  const now=Math.floor(nowMs/1000),head=enc({alg:"RS256",typ:"JWT"}),body=enc({iat:now-60,exp:now+540,iss:issuer}),input=`${head}.${body}`;
  return `${input}.${sign("RSA-SHA256",Buffer.from(input),createPrivateKey(privateKeyPem)).toString("base64url")}`;
}
