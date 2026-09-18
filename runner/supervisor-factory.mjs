import fs from "node:fs/promises";
import { LinuxCandidateSupervisor } from "./linux-supervisor.mjs";
import { MacCandidateSupervisor } from "./macos-supervisor.mjs";
function hostArch(){return process.arch==="x64"?"x64":process.arch==="arm64"?"arm64":process.arch;}
export class CandidateSupervisorFactory{
 async forInput(runner){if(!runner||runner.arch!==hostArch())throw new Error("runner host architecture does not match trusted request");if(runner.os==="macos"){if(process.platform!=="darwin")throw new Error("runner host OS mismatch");const v=(await fs.readFile("/System/Library/CoreServices/SystemVersion.plist","utf8")).match(/<key>ProductVersion<\/key>\s*<string>([^<]+)/)?.[1]||"";if(!v.startsWith(`${runner.version}.`))throw new Error("runner macOS version mismatch");return new MacCandidateSupervisor();}if(runner.os==="linux"){if(process.platform!=="linux")throw new Error("runner host OS mismatch");const t=await fs.readFile("/etc/os-release","utf8"),v=t.match(/^VERSION_ID="?([^"\n]+)"?/m)?.[1]||"";if(v!==runner.version)throw new Error("runner Linux version mismatch");return new LinuxCandidateSupervisor();}throw new Error("unsupported runner OS");}
}
