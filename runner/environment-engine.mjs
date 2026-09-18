import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync=promisify(execFile);
const MISE_VERSION="2026.9.10";
function wrap(step,environment,mise){const tools=environment.toolchains.map(x=>`${x.name}@${x.version}`);return Object.freeze({...step,argv:Object.freeze(tools.length?[mise,"exec",...tools,"--",...step.argv]:[...step.argv])});}
export class CandidateEnvironmentEngine{
 constructor({command=execFileAsync,miseBin=process.env.MISE_BIN||""}={}){this.command=command;this.miseBin=miseBin;}
 async installSystemPackages(runner,packages){if(!packages.length)return;if(runner.os==="linux"){const names=packages.map(x=>x.version?`${x.name}=${x.version}`:x.name);const env={PATH:"/usr/sbin:/usr/bin:/sbin:/bin",DEBIAN_FRONTEND:"noninteractive"};await this.command("/usr/bin/sudo",["-n","/usr/bin/apt-get","update"],{env});await this.command("/usr/bin/sudo",["-n","/usr/bin/apt-get","install","-y","--no-install-recommends",...names],{env});return;}if(runner.os==="macos"){if(packages.some(x=>x.version))throw new Error("exact Homebrew system-package versions are not safely supported in v1");const bin=runner.arch==="arm64"?"/opt/homebrew/bin/brew":"/usr/local/bin/brew";await this.command(bin,["install",...packages.map(x=>x.name)]);return;}throw new Error("unsupported system-package platform");}
 async prepare({runner,environment,validation_plan}){await this.installSystemPackages(runner,environment.system_packages);if(environment.toolchains.length&&(!this.miseBin||!this.miseBin.includes("mise")))throw new Error("pinned mise binary is unavailable");const steps=[...environment.setup_steps,...validation_plan.steps].map(step=>wrap(step,environment,this.miseBin));return Object.freeze({plan_id:validation_plan.plan_id,steps:Object.freeze(steps),mise_version:MISE_VERSION});}
}
