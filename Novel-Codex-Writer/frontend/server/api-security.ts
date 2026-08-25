import type { IncomingMessage } from "node:http";
import { TextDecoder } from "node:util";
import { ApiError } from "./file-storage.ts";

export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

function normalizeAddress(value: string | undefined) {
  return (value ?? "").trim().toLowerCase().replace(/^::ffff:/, "");
}

function isLoopbackAddress(value: string) {
  return value === "::1" || value === "127.0.0.1";
}

function trustedContainerGateways() {
  return new Set(
    (process.env.NOVEL_API_TRUSTED_PROXIES ?? "")
      .split(",")
      .map(normalizeAddress)
      .filter(Boolean)
  );
}

export function validateLocalRequest(req: Pick<IncomingMessage, "headers" | "socket">) {
  const allowed = new Set(["localhost", "127.0.0.1", "::1"]);
  const remoteAddress = normalizeAddress(req.socket.remoteAddress);
  const trustedDockerGateway = process.env.NOVEL_API_TRUST_DOCKER_GATEWAY === "true" && trustedContainerGateways().has(remoteAddress);
  if (!isLoopbackAddress(remoteAddress) && !trustedDockerGateway) {
    throw new ApiError(403, "连接对端不是本机回环地址，已拒绝访问。", "REMOTE_ADDRESS_FORBIDDEN");
  }
  const rawHost = req.headers.host ?? "";
  let hostname = "";
  let requestPort = "";
  try {
    const requestUrl = new URL(`http://${rawHost}`);
    hostname = requestUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    requestPort = requestUrl.port;
  } catch {
    throw new ApiError(403, "Host 不合法，API 仅允许本机访问。", "HOST_FORBIDDEN");
  }
  if (!allowed.has(hostname)) throw new ApiError(403, "API 仅允许 localhost 或回环地址访问。", "HOST_FORBIDDEN");

  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const originUrl = new URL(origin);
    const originHost = originUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (originUrl.protocol !== "http:" || originHost !== hostname || originUrl.port !== requestPort) throw new Error("remote origin");
  } catch {
    throw new ApiError(403, "Origin 不是本机地址，已拒绝请求。", "ORIGIN_FORBIDDEN");
  }
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
    throw new ApiError(413, "请求体不能超过 2 MiB。");
  }

  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) throw new ApiError(413, "请求体不能超过 2 MiB。");
    chunks.push(value);
  }

  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new ApiError(400, "请求体不是合法 UTF-8 文本。", "REQUEST_BODY_UTF8_INVALID");
  }
  if (!body.trim()) throw new ApiError(400, "请求体不能为空，且必须是 JSON 对象。", "REQUEST_BODY_REQUIRED");
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError(400, "请求体必须是 JSON 对象。", "REQUEST_BODY_OBJECT_REQUIRED");
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "请求体不是合法 JSON。");
  }
}
