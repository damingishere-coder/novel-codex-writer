import type {
  AiEngine,
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
  SearchResponse,
  TrashEntry,
  TrashRestoreResponse,
  VersionDiff,
  VersionsResponse,
  WorkflowStatus,
  AiSuggestion,
  ChapterReviewRun,
  ReviewContextManifestItem,
  ReviewFinding
} from "../types";

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

type Validator<T> = (value: unknown) => value is T;

async function fetchJson<T>(url: string, validator: Validator<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const raw = await response.text();
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : undefined;
  } catch {
    if (response.ok) throw new ApiRequestError(response.status, "INVALID_RESPONSE", "服务器返回了无效的 JSON。");
  }

  if (!response.ok) {
    const error = responseErrorFromPayload(payload, `请求失败：${response.status}`);
    throw new ApiRequestError(response.status, error.code, error.message);
  }

  if (payload === undefined) throw new ApiRequestError(response.status, "EMPTY_RESPONSE", "服务器返回了空响应。");
  if (!validator(payload)) {
    throw new ApiRequestError(response.status, "INVALID_RESPONSE_SCHEMA", "服务器返回的数据结构无效。");
  }

  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

export function fetchProjects(signal?: AbortSignal) {
  return fetchJson<ProjectsResponse>("/api/projects", isProjectsResponse, { signal });
}

export function createProject(name: string) {
  return fetchJson<ProjectMutationResponse>("/api/projects", isProjectMutationResponse, jsonRequest("POST", { name }));
}

export function updateProject(projectId: string, body: { name?: string; active?: boolean }, signal?: AbortSignal) {
  return fetchJson<ProjectMutationResponse>(
    `/api/projects/${encodeURIComponent(projectId)}`,
    isProjectMutationResponse,
    { ...jsonRequest("PATCH", body), signal }
  );
}

export function deleteProject(projectId: string) {
  return fetchJson<ProjectMutationResponse>(`/api/projects/${encodeURIComponent(projectId)}`, isProjectMutationResponse, jsonRequest("DELETE"));
}

export function fetchLibrary(projectId: string, signal?: AbortSignal) {
  return fetchJson<LibraryResponse>(`/api/library?projectId=${encodeURIComponent(projectId)}`, isLibraryResponse, { signal });
}

export function fetchDocument(projectId: string, path: string, signal?: AbortSignal) {
  return fetchJson<DocumentResponse>(
    `/api/document?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`,
    isDocumentResponse,
    { signal }
  );
}

export function saveDocument(projectId: string, path: string, content: string) {
  return fetchJson<DocumentResponse>(
    `/api/document?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`,
    isDocumentResponse,
    jsonRequest("PUT", { content, expectedRevision: "" })
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
    isDocumentResponse,
    jsonRequest("PUT", { content, expectedRevision })
  );
}

export function deleteDocument(projectId: string, path: string) {
  return fetchJson<DeleteDocumentResponse>(
    `/api/document?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`,
    isDeleteDocumentResponse,
    jsonRequest("DELETE")
  );
}

export function fetchSearch(projectId: string, query: string, signal?: AbortSignal) {
  return fetchJson<SearchResponse>(
    `/api/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(query)}`,
    isSearchResponse,
    { signal }
  );
}

export function fetchAiStatus(signal?: AbortSignal) {
  return fetchJson<AiStatus>("/api/ai/status", isAiStatus, { signal });
}

export function updateAiSettings(settings: AiSettingsUpdate | Partial<AiSettingsUpdate>) {
  return fetchJson<AiStatus>("/api/ai/settings", isAiStatus, jsonRequest("PATCH", settings));
}

export function fetchReviewSession(projectId: string, path: string, signal?: AbortSignal) {
  return fetchJson<ReviewSession>(
    `/api/review-session?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`,
    isReviewSession,
    { signal }
  );
}

export function saveReviewSession(session: ReviewSession) {
  return fetchJson<ReviewSession>(
    `/api/review-session?projectId=${encodeURIComponent(session.projectId)}&path=${encodeURIComponent(session.documentPath)}`,
    isReviewSession,
    jsonRequest("PUT", { ...session, expectedRevision: session.sessionRevision })
  );
}

export function fetchWorkflowStatus(projectId: string, chapter?: number, signal?: AbortSignal) {
  const chapterQuery = chapter ? `&chapter=${chapter}` : "";
  return fetchJson<WorkflowStatus>(`/api/workflow/status?projectId=${encodeURIComponent(projectId)}${chapterQuery}`, isWorkflowStatus, { signal });
}

export function runWorkflowAction(projectId: string, input: Record<string, unknown>, signal?: AbortSignal) {
  return fetchJson<{ action: string; status: WorkflowStatus; output?: string }>(
    `/api/workflow/actions?projectId=${encodeURIComponent(projectId)}`,
    isWorkflowActionResponse,
    { ...jsonRequest("POST", input), signal }
  );
}

export function fetchVersions(projectId: string, path: string, signal?: AbortSignal) {
  return fetchJson<VersionsResponse>(`/api/versions?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`, isVersionsResponse, { signal });
}

export function fetchVersionDiff(projectId: string, path: string, versionId: string, signal?: AbortSignal) {
  return fetchJson<VersionDiff>(`/api/versions?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}&versionId=${encodeURIComponent(versionId)}`, isVersionDiff, { signal });
}

export function restoreVersion(projectId: string, path: string, versionId: string, expectedRevision: string) {
  return fetchJson<DocumentResponse>(
    `/api/versions?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`,
    isDocumentResponse,
    jsonRequest("POST", { versionId, expectedRevision })
  );
}

export function fetchTrash(projectId: string, signal?: AbortSignal) {
  return fetchJson<{ entries: TrashEntry[] }>(`/api/trash?projectId=${encodeURIComponent(projectId)}`, isTrashEntriesResponse, { signal });
}

export function restoreTrash(projectId: string, entryId: string) {
  return fetchJson<TrashRestoreResponse>(
    `/api/trash?projectId=${encodeURIComponent(projectId)}`,
    isTrashRestoreResponse,
    jsonRequest("POST", { entryId })
  );
}

export function exportBook(projectId: string, type: "markdown" | "zip") {
  return fetchJson<{ path: string; size?: number; missingChapters?: number[] }>(
    `/api/export?projectId=${encodeURIComponent(projectId)}&type=${type}`,
    isBookExportResponse,
    jsonRequest("POST")
  );
}

export function exportReviewSession(projectId: string, path: string) {
  return fetchJson<{ path: string }>(
    `/api/review-session?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}&export=markdown`,
    isPathResponse,
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
    expectedRevision: string;
    requestId: string;
  },
  onEvent: (event: AiStreamEvent) => void,
  signal?: AbortSignal
) {
  const response = await fetch("/api/ai/suggest", { ...jsonRequest("POST", input), signal });
  if (!response.ok) {
    throw await readResponseError(response, `AI 请求失败：${response.status}`);
  }
  await readNdjsonStream(response, parseAiStreamEvent, onEvent, "AI");
}

export async function streamChapterReview(
  input: {
    projectId: string;
    documentPath: string;
    content: string;
    engine: AiEngine;
    expectedRevision: string;
    requestId: string;
  },
  onEvent: (event: ChapterReviewStreamEvent) => void,
  signal?: AbortSignal
) {
  const response = await fetch("/api/ai/review-chapter", { ...jsonRequest("POST", input), signal });
  if (!response.ok) {
    throw await readResponseError(response, `整章体检请求失败：${response.status}`);
  }
  await readNdjsonStream(response, parseChapterReviewStreamEvent, onEvent, "整章体检");
}

async function readResponseError(response: Response, fallback: string) {
  try {
    const payload: unknown = await response.json();
    const error = responseErrorFromPayload(payload, fallback);
    return new ApiRequestError(response.status, error.code, error.message);
  } catch {
    return new ApiRequestError(response.status, `HTTP_${response.status}`, fallback);
  }
}

function responseErrorFromPayload(payload: unknown, fallback: string) {
  return {
    code: isRecord(payload) && requiredString(payload, "code") ? String(payload.code) : "REQUEST_FAILED",
    message: isRecord(payload) && typeof payload.error === "string" && payload.error ? payload.error : fallback
  };
}

function requiredString(record: Record<string, unknown>, key: string) {
  return typeof record[key] === "string" && record[key].length > 0;
}

function optionalString(record: Record<string, unknown>, key: string) {
  return record[key] === undefined || typeof record[key] === "string";
}

function isAiEngine(value: unknown): value is AiEngine {
  return value === "deepseek" || value === "codex";
}

const reviewSeverities = new Set(["S1", "S2", "S3", "S4"]);
const reviewCategories = new Set([
  "chapter_format", "outline", "continuity", "character", "timeline", "world",
  "foreshadowing", "pacing", "voice", "repetition", "language"
]);

function isOptionalPositiveInteger(value: unknown) {
  return value === undefined || (Number.isInteger(value) && Number(value) > 0);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonNegativeInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) > 0;
}

function isAiSuggestion(value: unknown): value is AiSuggestion {
  if (!isRecord(value)) return false;
  const usage = value.usage;
  const validUsage = usage === null || (isRecord(usage)
    && (usage.inputTokens === undefined || (typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens)))
    && (usage.outputTokens === undefined || (typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens))));
  return (value.decision === "change" || value.decision === "keep")
    && reviewSeverities.has(String(value.severity))
    && reviewCategories.has(String(value.category))
    && value.category !== "chapter_format"
    && typeof value.before === "string"
    && typeof value.after === "string"
    && requiredString(value, "rationale")
    && requiredString(value, "model")
    && validUsage;
}

function isReviewSourceRef(value: unknown) {
  return isRecord(value) && requiredString(value, "path") && typeof value.snippet === "string" && optionalString(value, "revision");
}

function isReviewFinding(value: unknown): value is ReviewFinding {
  if (!isRecord(value)) return false;
  const hasFromLine = value.fromLine !== undefined;
  const hasToLine = value.toLine !== undefined;
  return requiredString(value, "id")
    && (value.source === "local" || value.source === "ai")
    && reviewSeverities.has(String(value.severity))
    && reviewCategories.has(String(value.category))
    && requiredString(value, "title")
    && isOptionalPositiveInteger(value.fromLine)
    && isOptionalPositiveInteger(value.toLine)
    && hasFromLine === hasToLine
    && (!hasFromLine || Number(value.toLine) >= Number(value.fromLine))
    && optionalString(value, "before")
    && optionalString(value, "after")
    && typeof value.evidence === "string"
    && typeof value.impact === "string"
    && typeof value.fixSuggestion === "string"
    && ["not_needed", "pending", "confirmed", "unsupported", "unverified"].includes(String(value.verification))
    && isStringArray(value.lookupTerms)
    && Array.isArray(value.sourceRefs)
    && value.sourceRefs.every(isReviewSourceRef)
    && ["open", "accepted", "dismissed", "stale"].includes(String(value.status))
    && optionalString(value, "dismissalReason");
}

function isReviewContextManifestItem(value: unknown): value is ReviewContextManifestItem {
  return isRecord(value)
    && requiredString(value, "path")
    && requiredString(value, "role")
    && typeof value.characters === "number"
    && Number.isInteger(value.characters)
    && value.characters >= 0
    && typeof value.truncated === "boolean"
    && typeof value.missing === "boolean"
    && optionalString(value, "revision");
}

function isChapterReviewRun(value: unknown): value is ChapterReviewRun {
  if (!isRecord(value)) return false;
  const statusVerdictMatch = value.status === "stale"
    ? value.verdict === "stale"
    : value.status === "error"
      ? value.verdict === "needs_changes"
      : value.verdict === "pass" || value.verdict === "needs_changes";
  return requiredString(value, "id")
    && requiredString(value, "documentRevision")
    && isAiEngine(value.engine)
    && ["running", "completed", "error", "stale"].includes(String(value.status))
    && ["pass", "needs_changes", "stale"].includes(String(value.verdict))
    && statusVerdictMatch
    && typeof value.summary === "string"
    && Array.isArray(value.findings)
    && value.findings.every(isReviewFinding)
    && Array.isArray(value.contextManifest)
    && value.contextManifest.every(isReviewContextManifestItem)
    && requiredString(value, "promptVersion")
    && requiredString(value, "createdAt")
    && optionalString(value, "completedAt")
    && optionalString(value, "error");
}

const groupIds = new Set([
  "chapters", "current", "indexes", "archives", "outlines", "guides",
  "reviews", "commits", "memoryPatches", "snapshots"
]);
const annotationStatuses = new Set(["draft", "pending", "running", "ready", "accepted", "ignored", "stale", "error"]);

function isProjectSummary(value: unknown) {
  return isRecord(value)
    && requiredString(value, "id")
    && requiredString(value, "name")
    && requiredString(value, "root")
    && requiredString(value, "createdAt")
    && requiredString(value, "updatedAt");
}

function isProjectsResponse(value: unknown): value is ProjectsResponse {
  return isRecord(value)
    && requiredString(value, "libraryRoot")
    && (value.activeProjectId === null || typeof value.activeProjectId === "string")
    && Array.isArray(value.projects)
    && value.projects.every(isProjectSummary);
}

function isProjectMutationResponse(value: unknown): value is ProjectMutationResponse {
  if (!isProjectsResponse(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  const projectValid = record.project === undefined || isProjectSummary(record.project);
  const deletedValid = record.deleted === undefined || (isRecord(record.deleted)
    && requiredString(record.deleted, "id")
    && requiredString(record.deleted, "name")
    && optionalString(record.deleted, "trashedPath"));
  return projectValid && deletedValid;
}

function isDocumentEntry(value: unknown) {
  return isRecord(value)
    && requiredString(value, "id")
    && requiredString(value, "title")
    && requiredString(value, "path")
    && requiredString(value, "fileName")
    && groupIds.has(String(value.groupId))
    && requiredString(value, "groupLabel")
    && typeof value.section === "string"
    && isNonNegativeInteger(value.size)
    && isNonNegativeInteger(value.wordCount)
    && requiredString(value, "updatedAt")
    && isOptionalPositiveInteger(value.chapterNumber);
}

function isLibraryResponse(value: unknown): value is LibraryResponse {
  if (!isRecord(value) || !isRecord(value.stats) || !isRecord(value.featured)) return false;
  const stats = value.stats;
  const featured = value.featured;
  const validGroups = Array.isArray(value.groups) && value.groups.every((group) =>
    isRecord(group)
    && groupIds.has(String(group.id))
    && requiredString(group, "label")
    && typeof group.description === "string"
    && Array.isArray(group.entries)
    && group.entries.every(isDocumentEntry));
  const validFeatured = Object.values(featured).every((entry) => entry === undefined || isDocumentEntry(entry));
  return requiredString(value, "projectId")
    && requiredString(value, "projectName")
    && requiredString(value, "projectRoot")
    && requiredString(value, "generatedAt")
    && ["documents", "chapters", "currentFiles", "archiveFiles"].every((key) => isNonNegativeInteger(stats[key]))
    && validGroups
    && validFeatured;
}

function isDocumentResponse(value: unknown): value is DocumentResponse {
  return isRecord(value)
    && requiredString(value, "path")
    && requiredString(value, "title")
    && typeof value.content === "string"
    && requiredString(value, "updatedAt")
    && isNonNegativeInteger(value.size)
    && isNonNegativeInteger(value.wordCount)
    && requiredString(value, "revision");
}

function isDeleteDocumentResponse(value: unknown): value is DeleteDocumentResponse {
  return isRecord(value)
    && value.deleted === true
    && requiredString(value, "path")
    && requiredString(value, "trashedPath");
}

function isSearchResponse(value: unknown): value is SearchResponse {
  return isRecord(value)
    && typeof value.query === "string"
    && Array.isArray(value.results)
    && value.results.every((result) => isDocumentEntry(result) && typeof result.snippet === "string");
}

function isAiStatus(value: unknown): value is AiStatus {
  if (!isRecord(value) || !isRecord(value.settings)) return false;
  const isProvider = (provider: unknown) => isRecord(provider)
    && typeof provider.available === "boolean"
    && typeof provider.configured === "boolean"
    && typeof provider.model === "string"
    && (provider.error === null || typeof provider.error === "string");
  return isAiEngine(value.settings.engine)
    && typeof value.settings.model === "string"
    && ["low", "medium", "high"].includes(String(value.settings.reasoningEffort))
    && typeof value.settings.includeStyleGuide === "boolean"
    && typeof value.settings.includeWritingTaskbook === "boolean"
    && isProvider(value.deepseek)
    && isProvider(value.codex);
}

function isReviewConversationMessage(value: unknown) {
  return isRecord(value)
    && requiredString(value, "id")
    && (value.role === "user" || value.role === "assistant")
    && typeof value.content === "string"
    && (value.suggestion === undefined || isAiSuggestion(value.suggestion))
    && (value.engine === undefined || isAiEngine(value.engine))
    && requiredString(value, "createdAt");
}

function isReviewAnnotation(value: unknown) {
  return isRecord(value)
    && requiredString(value, "id")
    && isPositiveInteger(value.fromLine)
    && isPositiveInteger(value.toLine)
    && Number(value.toLine) >= Number(value.fromLine)
    && typeof value.comment === "string"
    && (value.messages === undefined || (Array.isArray(value.messages) && value.messages.every(isReviewConversationMessage)))
    && typeof value.originalText === "string"
    && isAiEngine(value.engine)
    && annotationStatuses.has(String(value.status))
    && requiredString(value, "anchorHash")
    && (value.suggestion === undefined || isAiSuggestion(value.suggestion))
    && optionalString(value, "error")
    && requiredString(value, "createdAt")
    && requiredString(value, "updatedAt");
}

function isReviewSession(value: unknown): value is ReviewSession {
  return isRecord(value)
    && value.schemaVersion === 4
    && requiredString(value, "projectId")
    && requiredString(value, "documentPath")
    && typeof value.baseRevision === "string"
    && (value.status === "active" || value.status === "completed")
    && Array.isArray(value.annotations)
    && value.annotations.every(isReviewAnnotation)
    && Array.isArray(value.chapterReviewRuns)
    && value.chapterReviewRuns.every(isChapterReviewRun)
    && requiredString(value, "updatedAt")
    && typeof value.sessionRevision === "string";
}

function isWorkflowArtifact(value: unknown) {
  return isRecord(value)
    && ["blueprint", "taskbook", "body", "review", "commit", "memoryPatch"].includes(String(value.id))
    && requiredString(value, "label")
    && ["missing", "ready", "needs_changes", "stale", "blocked", "finalized"].includes(String(value.status))
    && optionalString(value, "path")
    && optionalString(value, "revision")
    && typeof value.message === "string";
}

function isWorkflowContextItem(value: unknown) {
  return isRecord(value)
    && requiredString(value, "path")
    && requiredString(value, "role")
    && optionalString(value, "revision")
    && typeof value.missing === "boolean"
    && typeof value.stale === "boolean";
}

function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return isRecord(value)
    && value.schemaVersion === 1
    && requiredString(value, "projectId")
    && isPositiveInteger(value.chapter)
    && ["blocked", "needs_changes", "ready", "finalized"].includes(String(value.state))
    && Array.isArray(value.artifacts)
    && value.artifacts.every(isWorkflowArtifact)
    && ["copy_to_codex", "classify_patch", "generate_taskbook", "check_body", "apply_patch"].includes(String(value.recommendedAction))
    && typeof value.recommendation === "string"
    && Array.isArray(value.reviewContext)
    && value.reviewContext.every(isWorkflowContextItem)
    && isStringArray(value.legacyPatchChoices);
}

function isWorkflowActionResponse(value: unknown): value is { action: string; status: WorkflowStatus; output?: string } {
  return isRecord(value)
    && requiredString(value, "action")
    && isWorkflowStatus(value.status)
    && optionalString(value, "output");
}

function isDocumentVersion(value: unknown) {
  return isRecord(value)
    && requiredString(value, "id")
    && requiredString(value, "revision")
    && requiredString(value, "createdAt")
    && isNonNegativeInteger(value.size);
}

function isVersionsResponse(value: unknown): value is VersionsResponse {
  return isRecord(value)
    && requiredString(value, "path")
    && requiredString(value, "currentRevision")
    && Array.isArray(value.versions)
    && value.versions.every(isDocumentVersion);
}

function isVersionDiff(value: unknown): value is VersionDiff {
  return isRecord(value)
    && requiredString(value, "versionId")
    && requiredString(value, "historicalRevision")
    && requiredString(value, "currentRevision")
    && typeof value.before === "string"
    && typeof value.after === "string"
    && isPositiveInteger(value.fromLine);
}

function isTrashEntry(value: unknown): value is TrashEntry {
  return isRecord(value)
    && requiredString(value, "id")
    && requiredString(value, "path")
    && requiredString(value, "trashedPath")
    && requiredString(value, "deletedAt")
    && isNonNegativeInteger(value.size);
}

function isTrashEntriesResponse(value: unknown): value is { entries: TrashEntry[] } {
  return isRecord(value) && Array.isArray(value.entries) && value.entries.every(isTrashEntry);
}

function isTrashRestoreResponse(value: unknown): value is TrashRestoreResponse {
  return isRecord(value)
    && value.restored === true
    && requiredString(value, "path")
    && typeof value.recoveryArchived === "boolean";
}

function isPathResponse(value: unknown): value is { path: string } {
  return isRecord(value) && requiredString(value, "path");
}

function isBookExportResponse(value: unknown): value is { path: string; size?: number; missingChapters?: number[] } {
  return isRecord(value)
    && requiredString(value, "path")
    && (value.size === undefined || isNonNegativeInteger(value.size))
    && (value.missingChapters === undefined || (Array.isArray(value.missingChapters) && value.missingChapters.every(isPositiveInteger)));
}

export function parseAiStreamEvent(value: unknown): AiStreamEvent {
  if (!isRecord(value) || !requiredString(value, "type")) throw new Error("AI 流式响应缺少事件类型。");
  if (value.type === "error" && requiredString(value, "code") && requiredString(value, "message")) return value as unknown as AiStreamEvent;
  if (value.type === "started" && requiredString(value, "annotationId") && isAiEngine(value.engine)) return value as unknown as AiStreamEvent;
  if (value.type === "progress" && requiredString(value, "annotationId") && requiredString(value, "message")) return value as unknown as AiStreamEvent;
  if (value.type === "result"
    && requiredString(value, "annotationId")
    && isAiEngine(value.engine)
    && typeof value.reply === "string"
    && (value.suggestion === undefined || isAiSuggestion(value.suggestion))
    && requiredString(value, "anchorHash")) {
    return value as unknown as AiStreamEvent;
  }
  throw new Error(`AI 流式响应包含无效事件：${String(value.type)}`);
}

export function parseChapterReviewStreamEvent(value: unknown): ChapterReviewStreamEvent {
  if (!isRecord(value) || !requiredString(value, "type") || !requiredString(value, "message")) {
    throw new Error("整章体检流式响应格式无效。");
  }
  if (value.type === "error" && requiredString(value, "code") && (value.run === undefined || isChapterReviewRun(value.run))) return value as unknown as ChapterReviewStreamEvent;
  if (["started", "local_result", "audit_result", "verifying", "result"].includes(String(value.type)) && isChapterReviewRun(value.run)) {
    return value as unknown as ChapterReviewStreamEvent;
  }
  throw new Error(`整章体检流式响应包含无效事件：${String(value.type)}`);
}

async function readNdjsonStream<T>(
  response: Response,
  parseEvent: (value: unknown) => T,
  onEvent: (event: T) => void,
  label: string
) {
  if (!response.body) throw new Error(`浏览器无法读取${label}的流式响应。`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) onEvent(parseEvent(JSON.parse(line)));
      }
      if (done) break;
    }
    if (buffer.trim()) onEvent(parseEvent(JSON.parse(buffer)));
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
