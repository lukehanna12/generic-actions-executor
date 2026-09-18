import { randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);
const MAX_CAPTURE = 4 * 1024 * 1024;
const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin";

function opaqueGroupId() {
  return `grp_${randomBytes(18).toString("base64url")}`;
}

function inside(root, relative) {
  const resolved = path.resolve(root, relative || ".");
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (resolved !== path.resolve(root) && !resolved.startsWith(prefix))
    throw new Error("candidate cwd escapes private workspace");
  return resolved;
}

async function command(file, args, options = {}) {
  return execFileAsync(file, args, { maxBuffer: 1024 * 1024, ...options });
}

async function capture(stream, target) {
  let total = 0;
  const handle = await fs.open(target, "w", 0o600);
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > MAX_CAPTURE)
        throw new Error("candidate output exceeded private capture ceiling");
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
}

function sanitizedEnvironment(home) {
  return Object.freeze({
    PATH: SAFE_PATH,
    HOME: home,
    TMPDIR: path.join(home, "tmp"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "true",
    TERM: "dumb",
  });
}

export class LinuxCandidateSupervisor {
  constructor({
    spawnImpl = spawn,
    commandImpl = command,
    fsImpl = fs,
    now = () => new Date().toISOString(),
  } = {}) {
    this.spawn = spawnImpl;
    this.command = commandImpl;
    this.fs = fsImpl;
    this.now = now;
  }

  async preflight() {
    await this.command("/usr/bin/sudo", ["-n", "/usr/bin/true"]);
    await this.command("/usr/bin/test", ["-f", "/sys/fs/cgroup/cgroup.controllers"]);
    await this.command("/usr/bin/test", ["-x", "/usr/bin/setpriv"]);
  }

  async run({ workspace, validation_plan }) {
    if (!validation_plan || !Array.isArray(validation_plan.steps) || validation_plan.steps.length < 1)
      throw new Error("candidate validation plan is invalid");
    await this.preflight();
    const originalUid=String(process.getuid?.() ?? 1001), originalGid=String(process.getgid?.() ?? 1001);
    await this.command("/usr/bin/sudo", ["-n","/usr/bin/chown","-R","65534:65534",workspace]);
    const groupId = opaqueGroupId();
    const cgroup = `/sys/fs/cgroup/${groupId}`;
    const privateDir = await this.fs.mkdtemp("/tmp/generic-capture-");
    await this.fs.chmod(privateDir, 0o700);
    const candidateHome = `/tmp/${groupId}-home`;

    await this.command("/usr/bin/sudo", ["-n", "/usr/bin/mkdir", cgroup]);
    await this.command("/usr/bin/sudo", [
      "-n", "/usr/bin/install", "-d", "-m", "700", "-o", "65534", "-g", "65534",
      candidateHome, `${candidateHome}/tmp`,
    ]);
    const results = [];
    try {
      for (const step of validation_plan.steps) {
        const cwd = inside(workspace, step.cwd || ".");
        const stdoutPath = path.join(privateDir, `${results.length}.out`);
        const stderrPath = path.join(privateDir, `${results.length}.err`);
        const env = sanitizedEnvironment(candidateHome);
        const envArgs = Object.entries(env).flatMap(([key, value]) => [`${key}=${value}`]);
        const script = 'echo "$$" > "$1/cgroup.procs"; shift; exec "$@"';
        const argv = Array.isArray(step.argv) ? step.argv.map(String) : [];
        if (argv.length < 1) throw new Error("candidate step argv is empty");
        const child = this.spawn("/usr/bin/sudo", [
          "-n",
          "/bin/sh",
          "-c",
          script,
          "sh",
          cgroup,
          "/usr/bin/setpriv",
          "--reuid=65534",
          "--regid=65534",
          "--clear-groups",
          "--no-new-privs",
          "--inh-caps=-all",
          "--bounding-set=-all",
          "/usr/bin/env",
          "-i",
          ...envArgs,
          ...argv,
        ], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: SAFE_PATH },
        });

        const timeoutMs = Math.min(Number(step.timeout_seconds || 900) * 1000, 3600 * 1000);
        const timer = setTimeout(() => {
          this.command("/usr/bin/sudo", ["-n", "/bin/sh", "-c", `echo 1 > ${cgroup}/cgroup.kill`]).catch(() => {});
        }, timeoutMs);
        const output = Promise.all([
          capture(child.stdout, stdoutPath),
          capture(child.stderr, stderrPath),
        ]);
        const exit = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        });
        clearTimeout(timer);
        await output;
        results.push({
          step_id: String(step.step_id),
          exit_code: Number.isInteger(exit.code) ? exit.code : null,
          signal: exit.signal || null,
          stdout: await this.fs.readFile(stdoutPath, "utf8"),
          stderr: await this.fs.readFile(stderrPath, "utf8"),
        });
      }
    } finally {
      await this.command("/usr/bin/sudo", ["-n", "/bin/sh", "-c", `echo 1 > ${cgroup}/cgroup.kill`]).catch(() => {});
      let empty = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const { stdout } = await this.command(
          "/usr/bin/sudo",
          ["-n", "/bin/cat", `${cgroup}/cgroup.procs`],
        ).catch(() => ({ stdout: "unknown" }));
        if (!String(stdout).trim()) {
          empty = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!empty)
        throw new Error("candidate cgroup is not empty after termination");
      await this.command("/usr/bin/sudo", ["-n", "/usr/bin/rmdir", cgroup]);
      await this.command("/usr/bin/sudo", ["-n", "/bin/rm", "-rf", candidateHome]);
      await this.command("/usr/bin/sudo", ["-n","/usr/bin/chown","-R",`${originalUid}:${originalGid}`,workspace]).catch(() => {});
    }

    const passed = results.every(step => step.exit_code === 0);
    return Object.freeze({
      group_id: groupId,
      terminated_at: this.now(),
      result: Object.freeze({
        outcome: passed ? "passed" : "failed",
        steps: Object.freeze(results),
      }),
      cleanup: async () => this.fs.rm(privateDir, { recursive: true, force: true }),
    });
  }
}
