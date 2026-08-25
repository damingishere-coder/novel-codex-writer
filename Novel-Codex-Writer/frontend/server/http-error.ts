import type { ServerResponse } from "node:http";
import { ApiError } from "./file-storage.ts";

let redactionRoots: string[] = [];

export class HttpError extends ApiError {}

export function configureErrorRedactionRoots(roots: string[]) {
  redactionRoots = roots.filter(Boolean).sort((left, right) => right.length - left.length);
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
}

export function getErrorCode(error: unknown) {
  return error instanceof ApiError ? error.code : "INTERNAL_ERROR";
}

export function redactErrorMessage(message: string) {
  let safe = message;
  for (const root of redactionRoots) safe = safe.split(root).join("<本机路径>");
  return safe
    .replace(/[A-Za-z]:[\\/][^\s"'<>|，。；：）)\]}]+/g, "<本机路径>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <已脱敏>")
    .replace(/\b(?:sk|ghp|github_pat|sess)[-_][A-Za-z0-9._-]{8,}/gi, "<已脱敏密钥>")
    .replace(/(["']?(?:api[_-]?key|client[_-]?secret|secret|key|token|password|cookie|authorization)["']?\s*:\s*")((?:\\.|[^"\\])*)"/gi, "$1<已脱敏>\"")
    .replace(/(["']?(?:api[_-]?key|client[_-]?secret|secret|key|token|password|cookie|authorization)["']?\s*:\s*')((?:\\.|[^'\\])*)'/gi, "$1<已脱敏>'")
    .replace(/((?:api[_-]?key|client[_-]?secret|secret|key|token|password|cookie|authorization)\s*[:=]\s*)[^\s,;，；]+/gi, "$1<已脱敏>")
    .replace(/([?&](?:api[_-]?key|key|token|password|auth)=)[^&#\s]+/gi, "$1<已脱敏>");
}

export function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function sendNdjson(res: ServerResponse, payload: unknown, end = false) {
  res.write(`${JSON.stringify(payload)}\n`);
  if (end) res.end();
}

export function sendError(res: ServerResponse, error: unknown) {
  if (error instanceof ApiError) {
    sendJson(res, error.statusCode, { code: error.code, error: redactErrorMessage(error.message) });
    return;
  }

  console.error(`[novel-library-api] 未处理错误：${redactErrorMessage(getErrorMessage(error))}`);
  sendJson(res, 500, { code: "INTERNAL_ERROR", error: "服务器处理失败，请查看本机终端日志。" });
}
