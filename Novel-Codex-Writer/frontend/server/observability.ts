export type OperationName = "library_scan" | "review_context" | "provider" | "export";

export interface OperationSample {
  durationMs?: number;
  files?: number;
  bytes?: number;
  characters?: number;
  failed?: boolean;
}

interface OperationTotals {
  count: number;
  failures: number;
  totalDurationMs: number;
  maxDurationMs: number;
  totalFiles: number;
  totalBytes: number;
  maxBytes: number;
  totalCharacters: number;
  maxCharacters: number;
}

const startedAt = new Date().toISOString();
const totals = new Map<OperationName, OperationTotals>();

function finiteNonNegative(value: number | undefined) {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value ?? 0 : 0;
}

function emptyTotals(): OperationTotals {
  return {
    count: 0,
    failures: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    totalFiles: 0,
    totalBytes: 0,
    maxBytes: 0,
    totalCharacters: 0,
    maxCharacters: 0
  };
}

export function recordOperation(name: OperationName, sample: OperationSample = {}) {
  const current = totals.get(name) ?? emptyTotals();
  const durationMs = finiteNonNegative(sample.durationMs);
  const files = finiteNonNegative(sample.files);
  const bytes = finiteNonNegative(sample.bytes);
  const characters = finiteNonNegative(sample.characters);
  current.count += 1;
  if (sample.failed) current.failures += 1;
  current.totalDurationMs += durationMs;
  current.maxDurationMs = Math.max(current.maxDurationMs, durationMs);
  current.totalFiles += files;
  current.totalBytes += bytes;
  current.maxBytes = Math.max(current.maxBytes, bytes);
  current.totalCharacters += characters;
  current.maxCharacters = Math.max(current.maxCharacters, characters);
  totals.set(name, current);
}

export async function observeOperation<T>(
  name: OperationName,
  sample: Omit<OperationSample, "durationMs" | "failed">,
  task: () => Promise<T>
) {
  const started = performance.now();
  try {
    const result = await task();
    recordOperation(name, { ...sample, durationMs: performance.now() - started });
    return result;
  } catch (error) {
    recordOperation(name, { ...sample, durationMs: performance.now() - started, failed: true });
    throw error;
  }
}

export function getMetricsSnapshot() {
  return {
    schemaVersion: 1,
    startedAt,
    operations: Object.fromEntries(
      Array.from(totals.entries(), ([name, value]) => [name, { ...value }])
    )
  };
}

export function resetMetricsForTests() {
  totals.clear();
}
