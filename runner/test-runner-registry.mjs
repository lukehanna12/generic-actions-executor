import assert from "node:assert/strict";
import { RUNNERS } from "./request.mjs";
import { TRIGGER_RUNNERS } from "./trigger-request.mjs";

const expected=[
  "ubuntu-22.04","ubuntu-22.04-arm","ubuntu-24.04","ubuntu-24.04-arm","ubuntu-26.04","ubuntu-26.04-arm","ubuntu-slim",
  "macos-14","macos-15","macos-15-intel","macos-26","macos-26-intel","xcode-27",
  "windows-2022","windows-2025","windows-2025-vs2026","windows-11-arm","windows-11-vs2026-arm"
].sort();
assert.deepEqual(Object.keys(RUNNERS).sort(),expected);
assert.deepEqual([...TRIGGER_RUNNERS].sort(),expected);
assert.deepEqual(RUNNERS["ubuntu-26.04"],{provider:"github-hosted",os:"linux",version:"26.04",arch:"x64",label:"ubuntu-26.04"});
assert.deepEqual(RUNNERS["ubuntu-26.04-arm"],{provider:"github-hosted",os:"linux",version:"26.04",arch:"arm64",label:"ubuntu-26.04-arm"});
assert.deepEqual(RUNNERS["ubuntu-slim"],{provider:"github-hosted",os:"linux",version:"24.04",arch:"x64",label:"ubuntu-slim"});
assert.deepEqual(RUNNERS["xcode-27"],{provider:"github-hosted",os:"macos",version:"27",arch:"arm64",label:"xcode-27"});
assert.deepEqual(RUNNERS["windows-2022"],{provider:"github-hosted",os:"windows",version:"2022",arch:"x64",label:"windows-2022"});
assert.deepEqual(RUNNERS["windows-2025"],{provider:"github-hosted",os:"windows",version:"2025",arch:"x64",label:"windows-2025"});
assert.deepEqual(RUNNERS["windows-2025-vs2026"],{provider:"github-hosted",os:"windows",version:"2025",arch:"x64",label:"windows-2025-vs2026"});
assert.deepEqual(RUNNERS["windows-11-arm"],{provider:"github-hosted",os:"windows",version:"11",arch:"arm64",label:"windows-11-arm"});
assert.deepEqual(RUNNERS["windows-11-vs2026-arm"],{provider:"github-hosted",os:"windows",version:"11",arch:"arm64",label:"windows-11-vs2026-arm"});
for(const alias of ["ubuntu-latest","macos-latest","windows-latest","xcode-27-xlarge","macos-26-xlarge","macos-26-large"]){
  assert.equal(Object.hasOwn(RUNNERS,alias),false,`${alias} must not be a trusted fixed-image label`);
}
console.log(`runner_registry_validated count=${expected.length}`);
