import { beforeEach, describe, expect, it } from "vitest";
import { getMetricsSnapshot, observeOperation, recordOperation, resetMetricsForTests } from "./observability";

describe("local aggregate observability", () => {
  beforeEach(() => resetMetricsForTests());

  it("only exposes aggregate counts and resource totals", () => {
    recordOperation("library_scan", { durationMs: 12, files: 3, bytes: 120 });
    recordOperation("library_scan", { durationMs: 8, files: 2, bytes: 80 });
    expect(getMetricsSnapshot().operations.library_scan).toEqual({
      count: 2,
      failures: 0,
      totalDurationMs: 20,
      maxDurationMs: 12,
      totalFiles: 5,
      totalBytes: 200,
      maxBytes: 120,
      totalCharacters: 0,
      maxCharacters: 0
    });
  });

  it("records failed provider calls without storing request content", async () => {
    await expect(observeOperation("provider", { characters: 42 }, async () => {
      throw new Error("provider failed");
    })).rejects.toThrow("provider failed");
    const snapshot = JSON.stringify(getMetricsSnapshot());
    expect(snapshot).toContain('"failures":1');
    expect(snapshot).not.toContain("provider failed");
  });
});
