import { createHash } from "node:crypto";

export const AI_SUGGESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "severity", "category", "before", "after", "rationale"],
  properties: {
    decision: { type: "string", enum: ["change", "keep"] },
    severity: { type: "string", enum: ["S1", "S2", "S3", "S4"] },
    category: {
      type: "string",
      enum: ["outline", "continuity", "character", "timeline", "world", "foreshadowing", "pacing", "voice", "repetition", "language"]
    },
    before: { type: "string" },
    after: { type: "string" },
    rationale: { type: "string" }
  }
} as const;

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
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, Math.min(fromLine, lines.length));
  const end = Math.max(start, Math.min(toLine, lines.length));
  return createHash("sha256")
    .update(`${start}:${end}\n${lines.slice(start - 1, end).join("\n")}`, "utf8")
    .digest("hex");
}

export function getLineText(content: string, fromLine: number, toLine: number) {
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, Math.min(fromLine, lines.length));
  const end = Math.max(start, Math.min(toLine, lines.length));
  return lines.slice(start - 1, end).join("\n");
}

export function replaceLineRange(content: string, fromLine: number, toLine: number, replacement: string) {
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, Math.min(fromLine, lines.length));
  const end = Math.max(start, Math.min(toLine, lines.length));
  lines.splice(start - 1, end - start + 1, ...replacement.split(/\r?\n/));
  return lines.join("\n");
}

export function makeReviewContext(content: string, fromLine: number, toLine: number, maxCharacters = 14_000) {
  if (content.length <= maxCharacters) return content;

  const lines = content.split(/\r?\n/);
  const start = Math.max(0, fromLine - 25);
  const end = Math.min(lines.length, toLine + 24);
  const excerpt = lines.slice(start, end).join("\n");
  return `[文档较长，已截取第 ${start + 1}-${end} 行]\n${excerpt}`.slice(0, maxCharacters);
}

export function safeSessionName(documentPath: string) {
  return `${createHash("sha256").update(documentPath, "utf8").digest("hex").slice(0, 24)}.json`;
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
  const decision = suggestion.decision;
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

  const legacySuggestion = parseSuggestion(response, expectedBefore);
  if (legacySuggestion) {
    return { reply: legacySuggestion.rationale, suggestion: legacySuggestion };
  }

  const nestedSuggestion = response.suggestion === null || response.suggestion === undefined
    ? undefined
    : parseSuggestion(response.suggestion, expectedBefore) ?? undefined;
  const reply = typeof response.reply === "string" ? response.reply.trim() : "";
  const normalizedReply = reply || nestedSuggestion?.rationale || "";
  if (!normalizedReply || normalizedReply.length > 8_000) return null;

  return {
    reply: normalizedReply,
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
