import { describe, expect, it, vi } from "vitest";
import { createContentLoadingTracker } from "./useProjectDocumentLifecycle";

describe("createContentLoadingTracker", () => {
  it("keeps loading true until every overlapping request finishes", () => {
    const onChange = vi.fn();
    const begin = createContentLoadingTracker(onChange);
    const finishLibrary = begin();
    const finishDocument = begin();

    finishLibrary();
    finishLibrary();
    finishDocument();

    expect(onChange.mock.calls.map(([value]) => value)).toEqual([true, true, true, false]);
  });
});
