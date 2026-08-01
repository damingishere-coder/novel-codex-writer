import type { DocumentEntry } from "../types";

export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  return `${(size / 1024).toFixed(1)} KB`;
}

export const CHAPTER_WORD_COUNT_MIN = 2000;
export const CHAPTER_WORD_COUNT_MAX = 2500;

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function formatWordCount(count: number) {
  return `${new Intl.NumberFormat("zh-CN").format(count)} 字`;
}

export function getChapterWordCountStatus(count: number) {
  if (count < CHAPTER_WORD_COUNT_MIN) return "short";
  if (count > CHAPTER_WORD_COUNT_MAX) return "long";
  return "valid";
}

export function formatChapterWordCountRange() {
  return `${formatWordCount(CHAPTER_WORD_COUNT_MIN)}-${formatWordCount(CHAPTER_WORD_COUNT_MAX)}`;
}

export function shortPath(path: string) {
  return path.replace(/^作品\/[^/]+\//, "");
}

export function describeEntry(entry?: DocumentEntry) {
  if (!entry) return "暂无文件";
  return `${entry.groupLabel} · ${formatBytes(entry.size)}`;
}

export function stripWebnovelMemoryMetadata(content: string) {
  return content
    .replace(/<!--\s*webnovel-memory:\s*[\s\S]*?-->\s*/gi, "")
    .replace(/\n{3,}/g, "\n\n");
}

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

export function createTextAnchor(content: string, fromLine: number, toLine: number) {
  const value = `${fromLine}:${toLine}\n${getLineText(content, fromLine, toLine)}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
