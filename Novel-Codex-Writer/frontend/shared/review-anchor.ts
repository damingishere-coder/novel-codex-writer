export function getAnchoredLineText(content: string, fromLine: number, toLine: number) {
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, Math.min(fromLine, lines.length));
  const end = Math.max(start, Math.min(toLine, lines.length));
  return lines.slice(start - 1, end).join("\n");
}

export function createSharedLineAnchor(content: string, fromLine: number, toLine: number) {
  const value = `${fromLine}:${toLine}\n${getAnchoredLineText(content, fromLine, toLine)}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
