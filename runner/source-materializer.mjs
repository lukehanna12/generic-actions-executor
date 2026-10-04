import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restrictWindowsTree } from "./windows-acl.mjs";

const execFileAsync = promisify(execFile);
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const ALLOWED_ARCHIVE_HOSTS = new Set(["codeload.github.com"]);

export function candidateSourceOwner(platform = process.platform) {
  if (platform === "darwin") return "nobody:nobody";
  if (platform === "linux") return "65534:65534";
  if (platform === "win32") return null;
  throw new Error("unsupported materializer platform");
}

function sha(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value))
    throw new Error("materializer commit must be a lowercase Git SHA");
  return value;
}

function validateArchiveDescriptor(archive, expectedCommit, nowMs) {
  if (!archive || typeof archive !== "object" || Array.isArray(archive))
    throw new Error("source archive descriptor is required");
  if (archive.commit_sha !== expectedCommit)
    throw new Error("source archive commit differs from private validation input");
  const url = new URL(archive.archive_url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !ALLOWED_ARCHIVE_HOSTS.has(url.hostname)
  )
    throw new Error("source archive URL uses an unapproved origin");
  const expiry = Date.parse(archive.expires_at);
  if (!Number.isFinite(expiry) || expiry <= nowMs || expiry - nowMs > 5 * 60 * 1000)
    throw new Error("source archive URL expiry is invalid");
  return Object.freeze({ url: url.href, expiry });
}

function validateTarList(text) {
  const entries = String(text).split(/\r?\n/).filter(Boolean);
  if (entries.length < 1)
    throw new Error("source archive is empty");
  for (const entry of entries) {
    const normalized=entry.replaceAll("\\","/");
    if (/^(?:[A-Za-z]:)?\//.test(normalized) || normalized.split("/").includes(".."))
      throw new Error("source archive contains an unsafe path");
  }
  return entries;
}

function tarBinary(platform=process.platform){
  if(platform!=="win32")return "/usr/bin/tar";
  const root=process.env.SystemRoot||process.env.WINDIR||"C:\\Windows";
  return path.join(root,"System32","tar.exe");
}

async function removeRoot(command,root){
  if(process.platform==="win32"){
    await fs.rm(root,{recursive:true,force:true});
    return;
  }
  await command("/usr/bin/sudo",["-n","/bin/rm","-rf",root]);
}

export class GitHubArchiveMaterializer {
  constructor({
    fetchImpl = fetch,
    commandImpl = execFileAsync,
    fsImpl = fs,
    now = () => Date.now(),
  } = {}) {
    this.fetch = fetchImpl;
    this.command = commandImpl;
    this.fs = fsImpl;
    this.now = now;
  }

  async download(url, target) {
    const response = await this.fetch(url, { redirect: "error" });
    if (!response.ok || !response.body)
      throw new Error(`source archive download failed with ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_ARCHIVE_BYTES)
      throw new Error("source archive exceeds the materializer size ceiling");

    const handle = await this.fs.open(target, "w", 0o600);
    let total = 0;
    try {
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > MAX_ARCHIVE_BYTES)
          throw new Error("source archive exceeds the materializer size ceiling");
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    if (total < 1)
      throw new Error("source archive download was empty");
  }

  async materialize({ input, archive }) {
    const commit = sha(input?.source?.commit_sha);
    const nowMs = this.now();
    if (!Number.isFinite(nowMs))
      throw new Error("materializer clock is invalid");
    const descriptor = validateArchiveDescriptor(archive, commit, nowMs);

    const root = await this.fs.mkdtemp(path.join(os.tmpdir(),"generic-source-"));
    if(process.platform==="win32")await restrictWindowsTree(root);
    else await this.fs.chmod(root, 0o700);
    const archivePath = path.join(root, "source.tar.gz");
    const workspace = path.join(root, "workspace");
    await this.fs.mkdir(workspace, { mode: 0o700 });

    try {
      await this.download(descriptor.url, archivePath);
      const tar=tarBinary();
      const listed = await this.command(tar, ["-tzf", archivePath], {
        maxBuffer: 16 * 1024 * 1024,
      });
      validateTarList(listed.stdout);

      const verbose = await this.command(tar, ["-tvzf", archivePath], {
        maxBuffer: 32 * 1024 * 1024,
      });
      for (const line of String(verbose.stdout).split(/\r?\n/).filter(Boolean)) {
        const type = line[0];
        if (type === "l" || type === "h")
          throw new Error("source archive contains a symbolic or hard link");
      }

      const args=["-xzf", archivePath,"--strip-components=1","-C",workspace];
      if(process.platform!=="win32")args.splice(3,0,"--no-same-owner","--no-same-permissions");
      await this.command(tar,args);
      await this.fs.rm(archivePath, { force: true });

      const owner=candidateSourceOwner();
      if(owner){
        const chown=process.platform==="darwin"?"/usr/sbin/chown":"/bin/chown";
        await this.command("/usr/bin/sudo", ["-n", chown, "-R", owner, root]);
        await this.command("/usr/bin/sudo", ["-n", "/bin/chmod", "700", root, workspace]);
      }

      return Object.freeze({
        workspace,
        commit_sha: commit,
        cleanup: async () => removeRoot(this.command,root),
      });
    } catch (error) {
      await removeRoot(this.command,root).catch(() => {});
      throw error;
    }
  }
}
