import { appJwt } from "./github-app.mjs";

export const REQUEST_RECORD_BRANCH = "executor/dispatch";

export function installationJwt({issuer,privateKeyPem}={}){
  return appJwt({issuer,privateKeyPem});
}
