import { createHash, randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rename, unlink, utimes } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { hostname } from "node:os";

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
  signal?: AbortSignal;
  createRoot?: boolean;
}

export class FileLockTimeoutError extends Error {
  constructor(public readonly key: string) {
    super(`Timed out waiting for write lock: ${key}`);
  }
}

function delay(milliseconds: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

interface LockOwner {
  owner?: unknown;
  pid?: unknown;
  host?: unknown;
  released?: unknown;
  createdMonotonicNs?: unknown;
}

async function lockOwnerOf(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const pathStat = await lstat(lockPath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) return undefined;
    return JSON.parse(await readFile(lockPath, "utf8")) as LockOwner;
  } catch {
    return undefined;
  }
}

async function ownerOf(lockPath: string) {
  const value = await lockOwnerOf(lockPath);
  return typeof value?.owner === "string" ? value.owner : undefined;
}

function hostIdentity(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function pidValueValid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffff_ffff;
}

async function cleanupDeadAcquireFiles(lockRoot: string, key: string, localHost: string) {
  const prefix = `${key}.lock.acquire.`;
  const localHostKey = hostIdentity(localHost);
  for (const name of await readdir(lockRoot)) {
    if (!name.startsWith(prefix)) continue;
    const target = resolve(lockRoot, name);
    const targetStat = await lstat(target).catch(() => undefined);
    if (!targetStat?.isFile() || targetStat.isSymbolicLink()) continue;
    const payload = await lockOwnerOf(target);
    const [fileHostKey, ownerFromName = ""] = name.slice(prefix.length).split(".", 2);
    const pidText = ownerFromName.split("-", 1)[0];
    const namePid = /^\d{1,10}$/.test(pidText) ? Number(pidText) : Number.NaN;
    if (payload?.host && payload.host !== localHost) continue;
    const payloadPid = payload?.host === localHost && pidValueValid(payload.pid) ? payload.pid : Number.NaN;
    const pid = pidValueValid(payloadPid) ? payloadPid : fileHostKey === localHostKey ? namePid : Number.NaN;
    if (pidValueValid(pid) && !processIsAlive(pid)) {
      await unlink(target).catch(() => undefined);
    }
  }
}

function processIsAlive(pid: number) {
  if (!pidValueValid(pid)) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function removeStaleLock(lockPath: string, staleMs: number) {
  const reclaimOwner = `${process.pid}-${randomUUID()}`;
  const localHost = hostname();
  const localHostKey = hostIdentity(localHost);
  const reclaimPath = `${lockPath}.reclaim.${localHostKey}.${reclaimOwner}`;
  const reclaimPrefix = `${basename(lockPath)}.reclaim.`;
  let candidateCreated = false;
  try {
    const initialPathStat = await lstat(lockPath);
    if (!initialPathStat.isFile() || initialPathStat.isSymbolicLink()) return false;
    const lockContents = await readFile(lockPath, "utf8");
    const lockOwner = (() => {
      try {
        return JSON.parse(lockContents) as LockOwner;
      } catch {
        return undefined;
      }
    })();
    const lockStat = await lstat(lockPath);
    const age = Date.now() - lockStat.mtimeMs;
    const released = lockOwner?.released === true;
    if (
      typeof lockOwner?.owner !== "string"
      || !pidValueValid(lockOwner.pid)
      || lockOwner.host !== localHost
    ) return false;
    if (released) {
      // The owner completes its bounded unlink retries within 85 ms. Waiting
      // two seconds ensures it can no longer delete a replacement lock (ABA).
      if (age <= 2_000 || processIsAlive(lockOwner.pid)) return false;
    } else if (age <= staleMs || processIsAlive(lockOwner.pid)) {
      return false;
    }

    const reclaimHandle = await open(reclaimPath, "wx", 0o600);
    try {
      await reclaimHandle.writeFile(JSON.stringify({
        owner: reclaimOwner,
        pid: process.pid,
        host: localHost,
        createdMonotonicNs: process.hrtime.bigint().toString()
      }));
      candidateCreated = true;
    } finally {
      await reclaimHandle.close();
    }

    // Let concurrent contenders publish their unique candidates, then elect the
    // oldest live local candidate. A crashed contender can be removed safely
    // because its UUID path is never reused.
    await delay(10);
    const candidates: Array<{ owner: string; createdMonotonicNs: bigint }> = [];
    for (const name of await readdir(dirname(lockPath))) {
      if (!name.startsWith(reclaimPrefix)) continue;
      const candidatePath = resolve(dirname(lockPath), name);
      let candidate: LockOwner | undefined;
      try {
        const candidateStat = await lstat(candidatePath);
        if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) return false;
        candidate = await lockOwnerOf(candidatePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return false;
      }
      if (
        typeof candidate?.owner !== "string"
        || !pidValueValid(candidate.pid)
        || typeof candidate.host !== "string"
        || typeof candidate.createdMonotonicNs !== "string"
        || !/^\d{1,32}$/.test(candidate.createdMonotonicNs)
      ) {
        const [fileHostKey, nameOwner = ""] = name.slice(reclaimPrefix.length).split(".", 2);
        const pidText = nameOwner.split("-", 1)[0];
        const candidatePid = /^\d{1,10}$/.test(pidText) ? Number(pidText) : Number.NaN;
        if (fileHostKey === localHostKey && pidValueValid(candidatePid) && !processIsAlive(candidatePid)) {
          await unlink(candidatePath).catch(() => undefined);
        } else {
          return false;
        }
        continue;
      }
      if (candidate.host !== localHost) return false;
      if (!processIsAlive(candidate.pid)) {
        if (candidate.owner !== reclaimOwner) await unlink(candidatePath).catch(() => undefined);
        continue;
      }
      candidates.push({ owner: candidate.owner, createdMonotonicNs: BigInt(candidate.createdMonotonicNs) });
    }
    candidates.sort((left, right) => {
      if (left.createdMonotonicNs < right.createdMonotonicNs) return -1;
      if (left.createdMonotonicNs > right.createdMonotonicNs) return 1;
      return left.owner.localeCompare(right.owner);
    });
    if (candidates[0]?.owner !== reclaimOwner) return false;

    const confirmedContents = await readFile(lockPath, "utf8");
    const confirmedStat = await lstat(lockPath);
    if (
      confirmedContents !== lockContents
      || confirmedStat.mtimeMs !== lockStat.mtimeMs
      || confirmedStat.size !== lockStat.size
      || Date.now() - confirmedStat.mtimeMs <= (released ? 2_000 : staleMs)
    ) return false;
    if (await ownerOf(reclaimPath) !== reclaimOwner) return false;
    const stalePath = `${lockPath}.stale.${randomUUID()}`;
    await rename(lockPath, stalePath);
    await unlink(stalePath).catch(() => undefined);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return false;
    throw error;
  } finally {
    if (candidateCreated && await ownerOf(reclaimPath) === reclaimOwner) {
      await unlink(reclaimPath).catch(() => undefined);
    }
  }
}

/**
 * Serializes cooperative writers across native and container Node processes.
 * The heartbeat lets a later process recover a lock left behind by a crash.
 */
export async function withCrossProcessLock<T>(
  lockRoot: string,
  key: string,
  task: (owner: string) => Promise<T>,
  options: FileLockOptions = {}
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/.test(key)) {
    throw new Error("Lock key must be a safe filename segment.");
  }
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 30_000;
  const retryMs = options.retryMs ?? 20;
  const owner = `${process.pid}-${randomUUID()}`;
  const lockPath = resolve(lockRoot, `${key}.lock`);
  const localHost = hostname();
  const acquirePath = `${lockPath}.acquire.${hostIdentity(localHost)}.${owner}`;
  const deadline = Date.now() + timeoutMs;
  if (options.createRoot === false) {
    const rootStat = await lstat(lockRoot);
    if (!rootStat.isDirectory()) throw new Error(`Lock root is not a directory: ${lockRoot}`);
  } else {
    await mkdir(lockRoot, { recursive: true });
    const rootStat = await lstat(lockRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Lock root is not a regular directory: ${lockRoot}`);
  }
  await cleanupDeadAcquireFiles(lockRoot, key, localHost);

  const acquireHandle = await open(acquirePath, "wx", 0o600);
  try {
    await acquireHandle.writeFile(JSON.stringify({ owner, pid: process.pid, host: localHost, createdAt: new Date().toISOString() }));
  } finally {
    await acquireHandle.close();
  }
  try {
    while (true) {
      if (options.signal?.aborted) {
        throw options.signal.reason instanceof Error ? options.signal.reason : new Error("等待文件锁时请求已取消。");
      }
      try {
        // Publish a complete lock payload atomically. A process paused while
        // preparing acquirePath cannot leave a half-written main lock.
        await link(acquirePath, lockPath);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "EACCES" && code !== "EPERM") throw error;
        if (code === "EEXIST" && await removeStaleLock(lockPath, staleMs)) continue;
        if (Date.now() >= deadline) throw new FileLockTimeoutError(key);
        await delay(retryMs + randomInt(Math.max(1, retryMs)));
      }
    }
  } finally {
    await unlink(acquirePath).catch(() => undefined);
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lockPath, now, now).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      console.warn(`[file-lock] 锁心跳更新失败（${code}）；跨主机请求将保持 fail-closed。`);
    });
  }, Math.max(1_000, Math.floor(staleMs / 3)));
  heartbeat.unref();

  try {
    return await task(owner);
  } finally {
    clearInterval(heartbeat);
    if (existsSync(lockPath) && (await ownerOf(lockPath)) === owner) {
      for (const retryDelay of [0, 10, 25, 50]) {
        if (retryDelay) await delay(retryDelay);
        if (await ownerOf(lockPath) !== owner) break;
        try {
          await unlink(lockPath);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
          if (retryDelay === 50) {
            console.warn("[file-lock] 锁文件暂未删除；保留完整 owner 记录，进程退出后才允许安全回收。");
          }
        }
      }
    }
  }
}
