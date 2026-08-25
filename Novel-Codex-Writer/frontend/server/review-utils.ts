import { createHash } from "node:crypto";
import { posix } from "node:path";
import { createSharedLineAnchor } from "../shared/review-anchor.ts";

export function countReadableWords(content: string) {
  const markdownText = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+.*$/gm, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ");

  const cjkPattern = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
  const cjkCount = markdownText.match(cjkPattern)?.length ?? 0;
  const latinWordCount =
    markdownText.replace(cjkPattern, " ").match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g)?.length ?? 0;

  return cjkCount + latinWordCount;
}

export function createRevision(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function createLineAnchor(content: string, fromLine: number, toLine: number) {
  lineRange(content, fromLine, toLine);
  return createSharedLineAnchor(content, fromLine, toLine);
}

function lineRange(content: string, fromLine: number, toLine: number) {
  const lines = content.split(/\r?\n/);
  if (!Number.isInteger(fromLine) || !Number.isInteger(toLine) || fromLine < 1 || toLine < fromLine || toLine > lines.length) {
    throw new RangeError("批注行号超出当前正文范围。");
  }
  return { lines, start: fromLine - 1, count: toLine - fromLine + 1 };
}

export function getLineText(content: string, fromLine: number, toLine: number) {
  const { lines, start, count } = lineRange(content, fromLine, toLine);
  return lines.slice(start, start + count).join("\n");
}

export function replaceLineRange(content: string, fromLine: number, toLine: number, replacement: string) {
  const { lines, start, count } = lineRange(content, fromLine, toLine);
  lines.splice(start, count, ...replacement.split(/\r?\n/));
  return lines.join("\n");
}

export function safeSessionName(documentPath: string) {
  const normalized = posix.normalize(documentPath.replace(/\\/g, "/").replace(/^\/+/, "")).normalize("NFC");
  const identity = process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
  return `${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 24)}.json`;
}

export function parseSuggestion(value: unknown, expectedBefore?: string) {
  if (!value || typeof value !== "object") return null;
  const suggestion = value as Record<string, unknown>;
  if (
    typeof suggestion.before !== "string" ||
    typeof suggestion.after !== "string" ||
    typeof suggestion.rationale !== "string"
  ) {
    return null;
  }
  const before = suggestion.before;
  const after = suggestion.after;
  const rationale = suggestion.rationale;
  if (!before || before.length > 10_000 || !after || after.length > 10_000 || !rationale.trim() || rationale.length > 2_000) {
    return null;
  }
  if (expectedBefore !== undefined && before !== expectedBefore) return null;
  if (suggestion.decision !== "keep" && suggestion.decision !== "change") return null;
  const decision = suggestion.decision as "keep" | "change";
  if (decision === "keep" && after !== before) return null;
  if (decision === "change" && after === before) return null;
  if (!["S1", "S2", "S3", "S4"].includes(String(suggestion.severity))) return null;
  const severity = suggestion.severity as "S1" | "S2" | "S3" | "S4";
  const allowedCategories = ["outline", "continuity", "character", "timeline", "world", "foreshadowing", "pacing", "voice", "repetition", "language"];
  if (!allowedCategories.includes(String(suggestion.category))) return null;
  const category = String(suggestion.category);
  return {
    decision,
    severity,
    category,
    before,
    after,
    rationale
  };
}

export function parseReviewReply(value: unknown, expectedBefore: string) {
  if (!value || typeof value !== "object") return null;
  const response = value as Record<string, unknown>;
  if (!("suggestion" in response) || typeof response.reply !== "string") return null;
  const nestedSuggestion = response.suggestion === null
    ? undefined
    : parseSuggestion(response.suggestion, expectedBefore) ?? null;
  if (nestedSuggestion === null) return null;
  const reply = typeof response.reply === "string" ? response.reply.trim() : "";
  if (!reply || reply.length > 8_000) return null;

  return {
    reply,
    suggestion: nestedSuggestion
  };
}

export function readEnvValue(content: string, name: string) {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0 || trimmed.slice(0, separator).trim() !== name) continue;
    const value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }
  return "";
}

export function setEnvValue(content: string, name: string, value: string) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("环境变量名称不正确。");
  if (/[\r\n]/.test(value)) throw new Error("环境变量值不能包含换行。");

  const lines = content ? content.split(/\r?\n/) : [];
  const replacement = `${name}=${value}`;
  let replaced = false;
  const next = lines.map((line) => {
    if (new RegExp(`^\\s*${name}\\s*=`).test(line)) {
      replaced = true;
      return replacement;
    }
    return line;
  });
  if (!replaced) {
    while (next.at(-1) === "") next.pop();
    if (next.length) next.push("");
    next.push(replacement);
  }
  return `${next.join("\n").replace(/\n+$/, "")}\n`;
}
