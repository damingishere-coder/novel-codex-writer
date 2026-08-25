import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { withCrossProcessLock } from "./file-lock";
import { withProjectSnapshotLock } from "./file-storage";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pythonCommand() {
  if (process.env.NOVEL_PYTHON_BIN) return { executable: process.env.NOVEL_PYTHON_BIN, prefix: [] as string[] };
  if (process.platform === "win32") {
    const launcher = resolve(process.env.SystemRoot ?? "C:\\Windows", "py.exe");
    const probe = spawnSync(launcher, ["-3", "-X", "utf8", "-c", "import sys; print(sys.executable)"], {
      encoding: "utf8",
      windowsHide: true
    });
    const executable = probe.status === 0 ? probe.stdout.trim() : "";
    if (executable) return { executable, prefix: [] as string[] };
  }
  return { executable: "python3", prefix: [] as string[] };
}

function runPythonReentrantLock(projectRoot: string, owner: string) {
  const scripts = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".agents", "skills", "webnovel-writer", "scripts");
  const code = [
    "import sys",
    "from pathlib import Path",
    "sys.path.insert(0, sys.argv[1])",
    "from memory_transactions import project_write_lock",
    "with project_write_lock(Path(sys.argv[2]), timeout_seconds=0.5):",
    "    print('reentered')"
  ].join("\n");
  const command = pythonCommand();
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(command.executable, [...command.prefix, "-X", "utf8", "-c", code, scripts, projectRoot], {
      windowsHide: true,
      env: {
        ...process.env,
        NOVEL_PARENT_PROJECT_LOCK_OWNER: owner,
        NOVEL_PARENT_PROJECT_LOCK_PID: String(process.pid)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.on("error", rejectPromise);
    child.on("close", (codeValue) => {
      if (codeValue === 0) resolvePromise(output);
      else rejectPromise(new Error(output || `Python exited with ${codeValue}`));
    });
  });
}

function runPythonThroughIntermediateParent(projectRoot: string, owner: string) {
  const scripts = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".agents", "skills", "webnovel-writer", "scripts");
  const inner = [
    "import sys",
    "from pathlib import Path",
    "sys.path.insert(0, sys.argv[1])",
    "from memory_transactions import project_write_lock",
    "try:",
    "    with project_write_lock(Path(sys.argv[2]), timeout_seconds=0.2):",
    "        print('forged-reentry')",
    "except Exception as exc:",
    "    print(type(exc).__name__ + ':' + str(exc))"
  ].join("\n");
  const outer = "import subprocess,sys; subprocess.run([sys.executable,'-X','utf8','-c',sys.argv[1],sys.argv[2],sys.argv[3]], check=True)";
  const command = pythonCommand();
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(command.executable, [...command.prefix, "-X", "utf8", "-c", outer, inner, scripts, projectRoot], {
      windowsHide: true,
      env: {
        ...process.env,
        NOVEL_PARENT_PROJECT_LOCK_OWNER: owner,
        NOVEL_PARENT_PROJECT_LOCK_PID: String(process.pid)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.on("error", rejectPromise);
    child.on("close", (codeValue) => codeValue === 0 ? resolvePromise(output) : rejectPromise(new Error(output)));
  });
}

describe("cross-process project lock", () => {
  it("rejects lock keys that can escape the lock root", async () => {
    const lockRoot = await mkdtemp(resolve(tmpdir(), "file-lock-key-"));
    roots.push(lockRoot);
    await expect(withCrossProcessLock(lockRoot, "../outside", async () => undefined))
      .rejects.toThrow("safe filename segment");
    await expect(withCrossProcessLock(lockRoot, "C:\\outside", async () => undefined))
      .rejects.toThrow("safe filename segment");
  });

  it("allows only the direct Python child to inherit the active Node lock", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "file-lock-python-"));
    roots.push(projectRoot);
    const lockRoot = resolve(projectRoot, ".locks");
    await mkdir(lockRoot, { recursive: true });

    const output = await withCrossProcessLock(lockRoot, "project-write", (owner) =>
      runPythonReentrantLock(projectRoot, owner)
    );
    expect(output).toContain("reentered");
  });

  it("rejects a forged inherited owner from a non-direct Python descendant", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "file-lock-forged-python-"));
    roots.push(projectRoot);
    const lockRoot = resolve(projectRoot, ".locks");
    await mkdir(lockRoot, { recursive: true });

    const output = await withCrossProcessLock(lockRoot, "project-write", (owner) =>
      runPythonThroughIntermediateParent(projectRoot, owner)
    );
    expect(output).toContain("MemorySystemError");
    expect(output).not.toContain("forged-reentry");
  });

  it("cancels a waiter before it acquires a busy lock", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "file-lock-abort-"));
    roots.push(projectRoot);
    const lockRoot = resolve(projectRoot, ".locks");
    await mkdir(lockRoot, { recursive: true });
    let release!: () => void;
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolvePromise) => { acquired = resolvePromise; });
    const hold = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const first = withCrossProcessLock(lockRoot, "project-write", async () => {
      acquired();
      await hold;
    });
    await acquiredPromise;

    const controller = new AbortController();
    const second = withCrossProcessLock(lockRoot, "project-write", async () => undefined, { signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await expect(second).rejects.toThrow("cancelled");
    release();
    await first;
  });

  it("does not reclaim an unverifiable lock owned by another host", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "file-lock-remote-host-"));
    roots.push(projectRoot);
    const lockRoot = resolve(projectRoot, ".locks");
    await mkdir(lockRoot, { recursive: true });
    const lockPath = resolve(lockRoot, "remote.lock");
    await writeFile(lockPath, JSON.stringify({ owner: "remote", pid: 1, host: "another-host" }), "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    await expect(withCrossProcessLock(lockRoot, "remote", async () => undefined, {
      staleMs: 10,
      timeoutMs: 30,
      retryMs: 5
    })).rejects.toThrow("Timed out waiting for write lock");
  });

  it("waits out the release unlink window before reclaiming a released lock", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "file-lock-released-grace-"));
    roots.push(projectRoot);
    const lockRoot = resolve(projectRoot, ".locks");
    await mkdir(lockRoot, { recursive: true });
    const lockPath = resolve(lockRoot, "released.lock");
    await writeFile(lockPath, JSON.stringify({ owner: "releasing", pid: process.pid, host: hostname(), released: true }), "utf8");

    await expect(withCrossProcessLock(lockRoot, "released", async () => undefined, {
      staleMs: 10,
      timeoutMs: 30,
      retryMs: 5
    })).rejects.toThrow("Timed out waiting for write lock");

    const deadProcess = spawnSync(process.execPath, ["-e", ""]);
    expect(deadProcess.status).toBe(0);
    await writeFile(lockPath, JSON.stringify({ owner: "released-dead", pid: deadProcess.pid, host: hostname(), released: true }), "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    await expect(withCrossProcessLock(lockRoot, "released", async () => "recovered", {
      staleMs: 10,
      timeoutMs: 1_000,
      retryMs: 2
    })).resolves.toBe("recovered");
  });

  it("removes an acquire artifact only after its local process is dead", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "file-lock-acquire-crash-"));
    roots.push(projectRoot);
    const lockRoot = resolve(projectRoot, ".locks");
    await mkdir(lockRoot, { recursive: true });
    const deadProcess = spawnSync(process.execPath, ["-e", ""]);
    expect(deadProcess.status).toBe(0);
    const hostKey = createHash("sha256").update(hostname(), "utf8").digest("hex").slice(0, 12);
    const orphan = resolve(lockRoot, `cleanup.lock.acquire.${hostKey}.${deadProcess.pid}-orphan`);
    await writeFile(orphan, "", "utf8");

    await expect(withCrossProcessLock(lockRoot, "cleanup", async () => "ok")).resolves.toBe("ok");
    expect(existsSync(orphan)).toBe(false);
  });

  it("fails closed for an invalid stale main-lock payload", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "file-lock-invalid-main-"));
    roots.push(projectRoot);
    const lockRoot = resolve(projectRoot, ".locks");
    await mkdir(lockRoot, { recursive: true });
    const lockPath = resolve(lockRoot, "invalid.lock");
    await writeFile(lockPath, "", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    await expect(withCrossProcessLock(lockRoot, "invalid", async () => undefined, {
      staleMs: 10,
      timeoutMs: 30,
      retryMs: 5
    })).rejects.toThrow("Timed out waiting for write lock");
  });

  it("serializes multiple waiters racing to reclaim the same stale lock", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "file-lock-stale-race-"));
    roots.push(projectRoot);
    const lockRoot = resolve(projectRoot, ".locks");
    await mkdir(lockRoot, { recursive: true });
    const lockPath = resolve(lockRoot, "stale-race.lock");
    await writeFile(lockPath, JSON.stringify({ owner: "dead", pid: 2_147_483_647, host: hostname() }), "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    let active = 0;
    let maximumActive = 0;
    await Promise.all(Array.from({ length: 16 }, () => withCrossProcessLock(lockRoot, "stale-race", async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      active -= 1;
    }, { staleMs: 10, timeoutMs: 5_000, retryMs: 2 })));
    expect(maximumActive).toBe(1);
  });

  it("recovers after a stale reclaim candidate was left by a crashed process", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "file-lock-reclaim-crash-"));
    roots.push(projectRoot);
    const lockRoot = resolve(projectRoot, ".locks");
    await mkdir(lockRoot, { recursive: true });
    const lockPath = resolve(lockRoot, "reclaim-crash.lock");
    const deadProcess = spawnSync(process.execPath, ["-e", ""]);
    const deadPid = deadProcess.pid;
    expect(deadProcess.status).toBe(0);
    await writeFile(lockPath, JSON.stringify({ owner: "dead", pid: deadPid, host: hostname() }), "utf8");
    const hostKey = createHash("sha256").update(hostname(), "utf8").digest("hex").slice(0, 12);
    const orphanCandidate = `${lockPath}.reclaim.${hostKey}.${deadPid}-orphan`;
    await writeFile(orphanCandidate, "", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    await utimes(orphanCandidate, old, old);

    await expect(withCrossProcessLock(lockRoot, "reclaim-crash", async () => "recovered", {
      staleMs: 10,
      timeoutMs: 1_000,
      retryMs: 2
    })).resolves.toBe("recovered");
    expect(existsSync(orphanCandidate)).toBe(false);
  });

  it("does not recreate a missing project while preparing its lock", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "file-lock-missing-project-"));
    roots.push(parent);
    const projectRoot = resolve(parent, "project");

    await expect(withProjectSnapshotLock(projectRoot, async () => undefined)).rejects.toMatchObject({
      code: "PROJECT_ROOT_MISSING"
    });
    expect(existsSync(projectRoot)).toBe(false);
  });

  it("recovers an interrupted deletion marker only after acquiring the project lock", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "file-lock-delete-recovery-"));
    roots.push(projectRoot);
    const marker = resolve(projectRoot, ".deleting");
    await writeFile(marker, "interrupted", "utf8");

    await expect(withProjectSnapshotLock(projectRoot, async () => "recovered")).resolves.toBe("recovered");
    expect(existsSync(marker)).toBe(false);
  });
});
