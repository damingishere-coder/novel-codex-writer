import { describe, expect, it } from "vitest";
import { decodeMountedPathId, normalizeWorkflowClassifications, parseAiSettingsPatch } from "./novel-library-plugin";

describe("local API request normalization", () => {
  it("rejects malformed mounted path encoding as a client error", () => {
    expect(() => decodeMountedPathId("/%E0%A4%A")).toThrow(expect.objectContaining({
      statusCode: 400,
      code: "INVALID_PATH_ENCODING"
    }));
  });

  it("accepts only bounded string workflow classifications", () => {
    expect(normalizeWorkflowClassifications({ "chapter-001-v1": "chapter_result" })).toEqual({
      "chapter-001-v1": "chapter_result"
    });
    for (const value of [{ patch: 1 }, { patch: { kind: "chapter_result" } }, ["chapter_result"]]) {
      expect(() => normalizeWorkflowClassifications(value)).toThrow(expect.objectContaining({
        statusCode: 400,
        code: "INVALID_CLASSIFICATIONS"
      }));
    }
  });

  it("rejects malformed AI settings instead of silently normalizing them", () => {
    expect(parseAiSettingsPatch({ engine: "deepseek", includeStyleGuide: false })).toMatchObject({
      engine: "deepseek",
      includeStyleGuide: false
    });
    for (const value of [[], { engine: "gpt" }, { reasoningEffort: "extreme" }, { includeStyleGuide: 1 }, { unknown: true }]) {
      expect(() => parseAiSettingsPatch(value)).toThrow(expect.objectContaining({
        statusCode: 400,
        code: "AI_SETTINGS_INVALID"
      }));
    }
  });
});
