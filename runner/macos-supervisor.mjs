import { randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
const MAX = 4 * 1024 * 1024;
const SAFE = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin";
const KILL_GRACE_MS = 5000;

function inside(root, rel) {
  const resolved = path.resolve(root, rel || ".");
  const prefix = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(prefix))
    throw new Error("candidate cwd escapes private workspace");
  return resolved;
}

async function readBounded(file) {
  const stat = await fs.stat(file);
  if (stat.size > MAX) throw new Error("candidate output exceeded private capture ceiling");
  return fs.readFile(file, "utf8");
}

function exitPromise(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function forceKill(child) {
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  try { child.kill("SIGKILL"); } catch {}
}

async function waitForExit(child, timeoutMs) {
  const exited = exitPromise(child);
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  let first;
  try { first = await Promise.race([exited, timeout]); }
  finally { clearTimeout(timer); }
  if (first) return { ...first, timed_out: false };

  forceKill(child);
  let killTimer;
  const afterKill = await Promise.race([
    exited,
    new Promise(resolve => {
      killTimer = setTimeout(() => resolve(null), KILL_GRACE_MS);
    }),
  ]);
  clearTimeout(killTimer);
  if (!afterKill) throw new Error("candidate did not terminate after SIGKILL");
  return { ...afterKill, timed_out: true };
}

export class MacCandidateSupervisor {
  constructor({ spawnImpl = spawn, command = exec, now = () => new Date().toISOString() } = {}) {
    this.spawn = spawnImpl;
    this.command = command;
    this.now = now;
  }

  async preflight() {
    if (process.platform !== "darwin") throw new Error("macOS supervisor requires Darwin");
    await this.command("/usr/bin/sudo", ["-n", "/usr/bin/true"]);
  }

  async run({ workspace, validation_plan }) {
    if (!validation_plan || !Array.isArray(validation_plan.steps) || validation_plan.steps.length < 1)
      throw new Error("candidate validation plan is invalid");

    await this.preflight();

    const id = `grp_${randomBytes(18).toString("base64url")}`;
    const home = await fs.mkdtemp("/tmp/generic-macos-home-");
    const capture = await fs.mkdtemp("/tmp/generic-macos-capture-");
    const originalUid = String(process.getuid?.() ?? 501);
    const originalGid = String(process.getgid?.() ?? 20);

    await this.command("/usr/bin/sudo", [
      "-n", "/usr/sbin/chown", "-R", "nobody:nobody", workspace,
    ]);
    await fs.chmod(home, 0o700);
    await this.command("/usr/bin/sudo", [
      "-n", "/usr/sbin/chown", "-R", "nobody:nobody", home,
    ]);

    const results = [];
    try {
      for (const step of validation_plan.steps) {
        const cwd = inside(workspace, step.cwd || ".");
        const stdoutPath = path.join(capture, `${results.length}.out`);
        const stderrPath = path.join(capture, `${results.length}.err`);
        const stdoutHandle = await fs.open(stdoutPath, "w", 0o600);
        const stderrHandle = await fs.open(stderrPath, "w", 0o600);
        const envArgs = [
          `PATH=${SAFE}`,
          `HOME=${home}`,
          `TMPDIR=${home}`,
          "LANG=C",
          "LC_ALL=C",
          "CI=true",
          "TERM=dumb",
        ];
        const argv = Array.isArray(step.argv) ? step.argv.map(String) : [];
        if (argv.length < 1) throw new Error("candidate step argv is empty");

        let exit;
        try {
          const child = this.spawn("/usr/bin/sudo", [
            "-n", "-u", "nobody",
            "/usr/bin/env", "-i",
            ...envArgs,
            "/bin/sh", "-c", 'cd -- "$1" && shift && exec "$@"',
            "candidate", cwd, ...argv,
          ], {
            // The controller cannot traverse the candidate-owned 0700 source.
            // sudo changes identity before the constant shim enters its cwd.
            cwd: "/tmp",
            detached: true,
            stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
            env: { PATH: SAFE },
          });

          const timeoutMs = Math.min(Number(step.timeout_seconds || 900) * 1000, 3600000);
          exit = await waitForExit(child, timeoutMs);
        } finally {
          await stdoutHandle.close();
          await stderrHandle.close();
        }

        results.push({
          step_id: String(step.step_id),
          exit_code: Number.isInteger(exit.code) ? exit.code : null,
          signal: exit.signal || null,
          timed_out: Boolean(exit.timed_out),
          stdout: await readBounded(stdoutPath),
          stderr: await readBounded(stderrPath),
        });
      }
    } finally {
      await this.command("/usr/bin/sudo", [
        "-n", "/usr/sbin/chown", "-R", `${originalUid}:${originalGid}`, workspace,
      ]).catch(() => {});
    }

    return Object.freeze({
      group_id: id,
      terminated_at: this.now(),
      result: Object.freeze({
        outcome: results.every(x => x.exit_code === 0 && !x.timed_out) ? "passed" : "failed",
        steps: Object.freeze(results),
      }),
      purge: async () => {
        await Promise.all([
          fs.rm(home, { recursive: true, force: true }),
          fs.rm(capture, { recursive: true, force: true }),
        ]);
      },
    });
  }
}

