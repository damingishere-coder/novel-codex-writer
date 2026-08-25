import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderAdapter, parseLastJson } from "./provider-adapter";

function provider() {
  return createProviderAdapter({
    deepSeekModel: "deepseek-test",
    maxOutputBytes: 1024 * 1024,
    suggestionSchemaFile: "unused.json",
    getRuntimeSecret: async () => "test-placeholder",
    getCodexBin: () => "unused",
    getCodexAuthFile: () => "unused"
  }).createReviewProvider("deepseek", process.cwd(), { reasoningEffort: "medium" });
}

async function requestJson() {
  return provider().requestJson({
    system: "system",
    user: "user",
    combined: "combined",
    schemaFile: "unused.json",
    maxTokens: 100,
    signal: new AbortController().signal
  });
}

async function requestReply() {
  return provider().requestReply({
    system: "system",
    user: "user",
    combined: "combined",
    expectedBefore: "原文",
    signal: new AbortController().signal
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider response boundary", () => {
  it("maps malformed trailing Codex output to the stable invalid-response code", () => {
    expect(() => parseLastJson("diagnostic log\n{\"partial\": {")).toThrowError(expect.objectContaining({
      statusCode: 502,
      code: "PROVIDER_RESPONSE_INVALID"
    }));
  });

  it("extracts the last complete nested JSON value after Codex diagnostic logs", () => {
    expect(parseLastJson("diagnostic {not-json}\n{\"reply\":{\"text\":\"brace } in string\"},\"items\":[1,2]}\nfinished"))
      .toEqual({ reply: { text: "brace } in string" }, items: [1, 2] });
    expect(parseLastJson("diagnostic {unfinished\n{\"ok\":{\"nested\":true}}\nfinished"))
      .toEqual({ ok: { nested: true } });
  });

  it("maps a non-object DeepSeek payload to the stable invalid-response code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("null", { status: 200 })));
    await expect(requestJson()).rejects.toMatchObject({
      statusCode: 502,
      code: "PROVIDER_RESPONSE_INVALID"
    });
  });

  it("rejects a successful response without string message content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: null } }]
    }), { status: 200 })));
    await expect(requestJson()).rejects.toMatchObject({
      statusCode: 502,
      code: "PROVIDER_RESPONSE_INVALID"
    });
  });

  it("maps a structurally invalid review reply to the stable invalid-response code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ unexpected: true }) } }]
    }), { status: 200 })));
    await expect(requestReply()).rejects.toMatchObject({
      statusCode: 502,
      code: "PROVIDER_RESPONSE_INVALID"
    });
  });
});
