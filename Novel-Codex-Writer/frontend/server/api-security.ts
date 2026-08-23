import type { IncomingMessage } from "node:http";
import { ApiError } from "./file-storage";

export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

export function validateLocalRequest(req: Pick<IncomingMessage, "headers">) {
  const allowed = new Set(["localhost", "127.0.0.1", "::1"]);
  const rawHost = req.headers.host ?? "";
  let hostname = "";
  try {
    hostname = new URL(`http://${rawHost}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    throw new ApiError(403, "Host 不合法，API 仅允许本机访问。");
  }
  if (!allowed.has(hostname)) throw new ApiError(403, "API 仅允许 localhost 或回环地址访问。");

  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const originHost = new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!allowed.has(originHost)) throw new Error("remote origin");
  } catch {
    throw new ApiError(403, "Origin 不是本机地址，已拒绝请求。");
  }
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  let body = "";
  let bytes = 0;
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
    throw new ApiError(413, "请求体不能超过 2 MiB。");
  }

  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) throw new ApiError(413, "请求体不能超过 2 MiB。");
    body += value.toString("utf8");
  }

  if (!body.trim()) return {} as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ApiError(400, "请求体不是合法 JSON。");
  }
}
