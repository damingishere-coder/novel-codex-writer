export interface SearchableDocument {
  title: string;
  path: string;
  content: string;
}

export interface SearchDocumentMatch {
  score: number;
  snippet: string;
}

export function stripWebnovelMemoryMetadata(content: string) {
  return content
    .replace(/<!--\s*webnovel-memory:\s*[\s\S]*?-->\s*/gi, "")
    .replace(/\n{3,}/g, "\n\n");
}

export function parseSearchTerms(query: string) {
  return Array.from(new Set(query.trim().toLocaleLowerCase("zh-CN").split(/\s+/).filter(Boolean)));
}

export function matchSearchDocument(query: string, document: SearchableDocument): SearchDocumentMatch | null {
  const terms = parseSearchTerms(query);
  if (!terms.length) return null;

  const readableContent = stripWebnovelMemoryMetadata(document.content);
  const title = document.title.toLocaleLowerCase("zh-CN");
  const path = document.path.toLocaleLowerCase("zh-CN");
  const content = readableContent.toLocaleLowerCase("zh-CN");
  let score = 0;

  for (const term of terms) {
    const titleMatched = title.includes(term);
    const pathMatched = path.includes(term);
    const contentMatches = countOccurrences(content, term);

    if (!titleMatched && !pathMatched && contentMatches === 0) return null;
    if (titleMatched) score += 20;
    if (pathMatched) score += 10;
    score += Math.min(contentMatches, 5) * 2;
  }

  return {
    score,
    snippet: makeSearchSnippet(readableContent, terms, title, path)
  };
}

function countOccurrences(content: string, term: string) {
  let count = 0;
  let offset = 0;

  while (offset < content.length) {
    const index = content.indexOf(term, offset);
    if (index < 0) break;
    count += 1;
    offset = index + Math.max(term.length, 1);
  }

  return count;
}

function makeSearchSnippet(content: string, terms: string[], title: string, path: string) {
  const normalizedContent = content.toLocaleLowerCase("zh-CN");
  const contentMatches = terms
    .map((term) => ({ term, index: normalizedContent.indexOf(term) }))
    .filter((match) => match.index >= 0)
    .sort((left, right) => left.index - right.index);

  if (!contentMatches.length) {
    const matchedTerm = terms.find((term) => title.includes(term) || path.includes(term)) ?? terms[0];
    return `标题或路径匹配：${matchedTerm}`;
  }

  const firstMatch = contentMatches[0];
  const start = Math.max(0, firstMatch.index - 56);
  const end = Math.min(content.length, firstMatch.index + firstMatch.term.length + 96);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}
