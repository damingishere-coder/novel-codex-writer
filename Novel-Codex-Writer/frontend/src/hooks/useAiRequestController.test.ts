import { describe, expect, it, vi } from "vitest";
import { AiRequestController } from "./useAiRequestController";

describe("AiRequestController", () => {
  it("deduplicates a key and releases it after finish", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" });
    const controller = new AiRequestController();
    controller.setActiveDocumentKey("project:a.md");
    const first = controller.start("chapter:project:a.md");
    expect(first).not.toBeNull();
    expect(controller.start("chapter:project:a.md")).toBeNull();
    controller.finish(first!);
    expect(controller.start("chapter:project:a.md")).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("aborts active work and rejects old responses after document switch", () => {
    const controller = new AiRequestController();
    controller.setActiveDocumentKey("project:a.md");
    const handle = controller.start("annotation:a")!;
    controller.setActiveDocumentKey("project:b.md");
    expect(handle.controller.signal.aborted).toBe(true);
    expect(controller.isCurrent(handle)).toBe(false);
  });

  it("does not release a replacement request when an aborted request finishes late", () => {
    const controller = new AiRequestController();
    controller.setActiveDocumentKey("project:a.md");
    const oldHandle = controller.start("annotation:a")!;
    controller.setActiveDocumentKey("project:b.md");
    const replacement = controller.start("annotation:a")!;

    controller.finish(oldHandle);

    expect(controller.start("annotation:a")).toBeNull();
    controller.finish(replacement);
    expect(controller.start("annotation:a")).not.toBeNull();
  });
});
