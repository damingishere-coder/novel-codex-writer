import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { MAX_REQUEST_BODY_BYTES, readJsonBody, validateLocalRequest } from "./api-security";

function request(chunks: Array<string | Buffer>, headers: IncomingMessage["headers"] = {}) {
  return Object.assign(Readable.from(chunks), { headers }) as IncomingMessage;
}

describe("local API boundary", () => {
  it("accepts loopback Host/Origin and rejects remote values", () => {
    expect(() => validateLocalRequest(request([], { host: "127.0.0.1:5173", origin: "http://localhost:5173" }))).not.toThrow();
    expect(() => validateLocalRequest(request([], { host: "[::1]:5173" }))).not.toThrow();
    expect(() => validateLocalRequest(request([], { host: "example.com" }))).toThrowError(/仅允许/);
    expect(() => validateLocalRequest(request([], { host: "localhost:5173", origin: "https://example.com" }))).toThrowError(/Origin/);
  });

  it("parses valid JSON and rejects declared or streamed bodies over 2 MiB", async () => {
    await expect(readJsonBody<{ value: string }>(request(['{"value":"ok"}']))).resolves.toEqual({ value: "ok" });
    await expect(readJsonBody(request([], { "content-length": String(MAX_REQUEST_BODY_BYTES + 1) }))).rejects.toMatchObject({ statusCode: 413 });
    await expect(readJsonBody(request([Buffer.alloc(MAX_REQUEST_BODY_BYTES), Buffer.from("x")]))).rejects.toMatchObject({ statusCode: 413 });
  });

  it("returns a redaction-safe validation error for malformed JSON", async () => {
    await expect(readJsonBody(request(["{not-json"]))).rejects.toMatchObject({ statusCode: 400, message: "请求体不是合法 JSON。" });
  });
});
