import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { MAX_REQUEST_BODY_BYTES, readBinaryBody, readJsonBody, validateLocalRequest } from "./api-security";

function request(chunks: Array<string | Buffer>, headers: IncomingMessage["headers"] = {}, remoteAddress = "127.0.0.1") {
  return Object.assign(Readable.from(chunks), { headers, socket: { remoteAddress } }) as unknown as IncomingMessage;
}

describe("local API boundary", () => {
  it("accepts loopback Host/Origin and rejects remote values", () => {
    expect(() => validateLocalRequest(request([], { host: "localhost:5173", origin: "http://localhost:5173" }))).not.toThrow();
    expect(() => validateLocalRequest(request([], { host: "[::1]:5173" }))).not.toThrow();
    expect(() => validateLocalRequest(request([], { host: "example.com" }))).toThrowError(/仅允许/);
    expect(() => validateLocalRequest(request([], { host: "localhost:5173", origin: "https://example.com" }))).toThrowError(/Origin/);
    expect(() => validateLocalRequest(request([], { host: "localhost:5173", origin: "http://localhost:3000" }))).toThrowError(/Origin/);
    expect(() => validateLocalRequest(request([], { host: "localhost:5173", origin: "ftp://localhost:5173" }))).toThrowError(/Origin/);
    expect(() => validateLocalRequest(request([], { host: "localhost:5173" }, "192.168.1.20"))).toThrowError(/连接对端/);
    expect(() => validateLocalRequest(request([], { host: "localhost:5173" }, "::ffff:127.0.0.1"))).not.toThrow();
  });

  it("trusts only explicitly configured container gateways", () => {
    const previousEnabled = process.env.NOVEL_API_TRUST_DOCKER_GATEWAY;
    const previousProxies = process.env.NOVEL_API_TRUSTED_PROXIES;
    process.env.NOVEL_API_TRUST_DOCKER_GATEWAY = "true";
    process.env.NOVEL_API_TRUSTED_PROXIES = "172.30.250.1";
    try {
      expect(() => validateLocalRequest(request([], { host: "localhost:5173" }, "172.30.250.1"))).not.toThrow();
      expect(() => validateLocalRequest(request([], { host: "localhost:5173" }, "172.30.250.2"))).toThrowError(/连接对端/);
      expect(() => validateLocalRequest(request([], { host: "localhost:5173" }, "192.168.1.20"))).toThrowError(/连接对端/);
    } finally {
      if (previousEnabled === undefined) delete process.env.NOVEL_API_TRUST_DOCKER_GATEWAY;
      else process.env.NOVEL_API_TRUST_DOCKER_GATEWAY = previousEnabled;
      if (previousProxies === undefined) delete process.env.NOVEL_API_TRUSTED_PROXIES;
      else process.env.NOVEL_API_TRUSTED_PROXIES = previousProxies;
    }
  });

  it("parses valid JSON and rejects declared or streamed bodies over 2 MiB", async () => {
    await expect(readJsonBody<{ value: string }>(request(['{"value":"ok"}']))).resolves.toEqual({ value: "ok" });
    await expect(readJsonBody(request([], { "content-length": String(MAX_REQUEST_BODY_BYTES + 1) }))).rejects.toMatchObject({ statusCode: 413 });
    await expect(readJsonBody(request([Buffer.alloc(MAX_REQUEST_BODY_BYTES), Buffer.from("x")]))).rejects.toMatchObject({ statusCode: 413 });
  });

  it("returns a redaction-safe validation error for malformed JSON", async () => {
    await expect(readJsonBody(request([]))).rejects.toMatchObject({ statusCode: 400, code: "REQUEST_BODY_REQUIRED" });
    await expect(readJsonBody(request(["{not-json"]))).rejects.toMatchObject({ statusCode: 400, message: "请求体不是合法 JSON。" });
    await expect(readJsonBody(request(["null"]))).rejects.toMatchObject({ statusCode: 400, code: "REQUEST_BODY_OBJECT_REQUIRED" });
    await expect(readJsonBody(request(["[]"]))).rejects.toMatchObject({ statusCode: 400, code: "REQUEST_BODY_OBJECT_REQUIRED" });
  });

  it("decodes UTF-8 after joining chunks", async () => {
    const encoded = Buffer.from('{"value":"中文"}', "utf8");
    await expect(readJsonBody<{ value: string }>(request([
      encoded.subarray(0, 11),
      encoded.subarray(11, 12),
      encoded.subarray(12)
    ]))).resolves.toEqual({ value: "中文" });
  });

  it("按独立预算读取 ZIP 二进制请求体", async () => {
    await expect(readBinaryBody(request([Buffer.from([0, 1]), Buffer.from([2, 3])]), 4)).resolves.toEqual(Buffer.from([0, 1, 2, 3]));
    await expect(readBinaryBody(request([Buffer.alloc(5)]), 4)).rejects.toMatchObject({ statusCode: 413, code: "REQUEST_BODY_TOO_LARGE" });
    await expect(readBinaryBody(request([]), 4)).rejects.toMatchObject({ statusCode: 400, code: "REQUEST_BODY_REQUIRED" });
  });
});
