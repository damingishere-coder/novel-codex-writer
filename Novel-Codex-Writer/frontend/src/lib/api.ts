import type {
  AiEngine,
  AiSettings,
  AiSettingsUpdate,
  AiStatus,
  AiStreamEvent,
  ChapterReviewStreamEvent,
  DeleteDocumentResponse,
  DocumentResponse,
  LibraryResponse,
  ProjectMutationResponse,
  ProjectsResponse,
  ReviewConversationMessage,
  ReviewSession,
  SearchResponse
} from "../types";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload?.error ?? `请求失败：${response.status}`);
  }

  return payload as T;
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  };
}

export function fetchProjects() {
  return fetchJson<ProjectsResponse>("/api/projects");
}

export function createProject(name: string) {
  return fetchJson<ProjectMutationResponse>("/api/projects", jsonRequest("POST", { name }));
}

export function updateProject(projectId: string, body: { name?: string; active?: boolean }) {
  return fetchJson<ProjectMutationResponse>(`/api/projects/${encodeURIComponent(projectId)}`, jsonRequest("PATCH", body));
}

export function deleteProject(projectId: string) {
  return fetchJson<ProjectMutationResponse>(`/api/projects/${encodeURIComponent(projectId)}`, jsonRequest("DELETE"));
}

export function fetchLibrary(projectId: string) {
  return fetchJson<LibraryResponse>(`/api/library?projectId=${encodeURIComponent(projectId)}`);
}

export function fetchDocument(projectId: string, path: string) {
  return fetchJson<DocumentResponse>(
    `/api/document?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`
  );
}

export function saveDocument(projectId: string, path: string, content: string) {
  return fetchJson<DocumentResponse>(
    `/api/document?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`,
    jsonRequest("PUT", { content })
  );
}

export function saveDocumentRevision(
  projectId: string,
  path: string,
  content: string,
  expectedRevision: string
) {
  return fetchJson<DocumentResponse>(
    `/api/document?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`,
    jsonRequest("PUT", { content, expectedRevision })
  );
}

export function deleteDocument(projectId: string, path: string) {
  return fetchJson<DeleteDocumentResponse>(
    `/api/document?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`,
    jsonRequest("DELETE")
  );
}

export function fetchSearch(projectId: string, query: string, signal?: AbortSignal) {
  return fetchJson<SearchResponse>(
    `/api/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(query)}`,
    { signal }
  );
}

export function fetchAiStatus() {
  return fetchJson<AiStatus>("/api/ai/status");
}

export function updateAiSettings(settings: AiSettingsUpdate | Partial<AiSettingsUpdate>) {
  return fetchJson<AiStatus>("/api/ai/settings", jsonRequest("PATCH", settings));
}

export function fetchReviewSession(projectId: string, path: string) {
  return fetchJson<ReviewSession>(
    `/api/review-session?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`
  );
}

export function saveReviewSession(session: ReviewSession) {
  return fetchJson<ReviewSession>(
    `/api/review-session?projectId=${encodeURIComponent(session.projectId)}&path=${encodeURIComponent(session.documentPath)}`,
    jsonRequest("PUT", session)
  );
}

export function exportReviewSession(projectId: string, path: string) {
  return fetchJson<{ path: string }>(
    `/api/review-session?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}&export=markdown`,
    jsonRequest("POST")
  );
}

export async function streamAiSuggestion(
  input: {
    projectId: string;
    documentPath: string;
    content: string;
    fromLine: number;
    toLine: number;
    comment: string;
    engine: AiEngine;
    annotationId: string;
    history: ReviewConversationMessage[];
  },
  onEvent: (event: AiStreamEvent) => void
) {
  const response = await fetch("/api/ai/suggest", jsonRequest("POST", input));
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error ?? `AI 请求失败：${response.status}`);
  }
  if (!response.body) throw new Error("浏览器无法读取 AI 流式响应。");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line) as AiStreamEvent);
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as AiStreamEvent);
}

export async function streamChapterReview(
  input: {
    projectId: string;
    documentPath: string;
    content: string;
    engine: AiEngine;
  },
  onEvent: (event: ChapterReviewStreamEvent) => void
) {
  const response = await fetch("/api/ai/review-chapter", jsonRequest("POST", input));
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error ?? `整章体检请求失败：${response.status}`);
  }
  if (!response.body) throw new Error("浏览器无法读取整章体检的流式响应。");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line) as ChapterReviewStreamEvent);
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as ChapterReviewStreamEvent);
}
