export type GroupId =
  | "chapters"
  | "current"
  | "indexes"
  | "archives"
  | "outlines"
  | "guides"
  | "reviews"
  | "commits"
  | "memoryPatches"
  | "snapshots";

export interface DocumentEntry {
  id: string;
  title: string;
  path: string;
  fileName: string;
  groupId: GroupId;
  groupLabel: string;
  section: string;
  size: number;
  wordCount: number;
  updatedAt: string;
  chapterNumber?: number;
}

export interface LibraryGroup {
  id: GroupId;
  label: string;
  description: string;
  entries: DocumentEntry[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  root: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectsResponse {
  libraryRoot: string;
  activeProjectId: string | null;
  projects: ProjectSummary[];
}

export interface LibraryResponse {
  projectId: string;
  projectName: string;
  projectRoot: string;
  generatedAt: string;
  stats: {
    documents: number;
    chapters: number;
    currentFiles: number;
    archiveFiles: number;
  };
  groups: LibraryGroup[];
  featured: {
    latestChapter?: DocumentEntry;
    context?: DocumentEntry;
    activeCharacters?: DocumentEntry;
    activeForeshadowing?: DocumentEntry;
    timeline?: DocumentEntry;
    facts?: DocumentEntry;
    review?: DocumentEntry;
    commit?: DocumentEntry;
    memoryPatch?: DocumentEntry;
  };
}

export interface DocumentResponse {
  path: string;
  title: string;
  content: string;
  updatedAt: string;
  size: number;
  wordCount: number;
  revision: string;
}

export type WorkspaceMode = "preview" | "review" | "edit";
export type AiEngine = "deepseek" | "codex";
export type ReasoningEffort = "low" | "medium" | "high";
export type AnnotationStatus = "draft" | "pending" | "running" | "ready" | "accepted" | "ignored" | "stale" | "error";
export type ReviewSeverity = "S1" | "S2" | "S3" | "S4";
export type ReviewFindingCategory =
  | "chapter_format"
  | "outline"
  | "continuity"
  | "character"
  | "timeline"
  | "world"
  | "foreshadowing"
  | "pacing"
  | "voice"
  | "repetition"
  | "language";

export interface AiSettings {
  engine: AiEngine;
  model: string;
  reasoningEffort: ReasoningEffort;
  includeStyleGuide: boolean;
  includeWritingTaskbook: boolean;
}

export interface AiSettingsUpdate extends AiSettings {
  deepseekApiKey?: string;
}

export interface AiProviderStatus {
  available: boolean;
  configured: boolean;
  model: string;
  error: string | null;
}

export interface AiStatus {
  settings: AiSettings;
  deepseek: AiProviderStatus;
  codex: AiProviderStatus;
}

export interface AiSuggestion {
  decision: "change" | "keep";
  severity: ReviewSeverity;
  category: Exclude<ReviewFindingCategory, "chapter_format">;
  before: string;
  after: string;
  rationale: string;
  model: string;
  usage: { inputTokens?: number; outputTokens?: number } | null;
}

export interface ReviewConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  suggestion?: AiSuggestion;
  engine?: AiEngine;
  createdAt: string;
}

export interface ReviewSourceRef {
  path: string;
  snippet: string;
}

export interface ReviewFinding {
  id: string;
  source: "local" | "ai";
  severity: ReviewSeverity;
  category: ReviewFindingCategory;
  title: string;
  fromLine?: number;
  toLine?: number;
  before?: string;
  after?: string;
  evidence: string;
  impact: string;
  fixSuggestion: string;
  verification: "not_needed" | "pending" | "confirmed" | "unsupported" | "unverified";
  lookupTerms: string[];
  sourceRefs: ReviewSourceRef[];
  status: "open" | "accepted" | "dismissed" | "stale";
  dismissalReason?: string;
}

export interface ReviewContextManifestItem {
  path: string;
  role: string;
  characters: number;
  truncated: boolean;
  missing: boolean;
}

export interface ChapterReviewRun {
  id: string;
  documentRevision: string;
  engine: AiEngine;
  status: "running" | "completed" | "error" | "stale";
  verdict: "pass" | "needs_changes" | "stale";
  summary: string;
  findings: ReviewFinding[];
  contextManifest: ReviewContextManifestItem[];
  promptVersion: string;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

export interface ReviewAnnotation {
  id: string;
  fromLine: number;
  toLine: number;
  comment: string;
  messages?: ReviewConversationMessage[];
  originalText: string;
  engine: AiEngine;
  status: AnnotationStatus;
  anchorHash: string;
  suggestion?: AiSuggestion;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewSession {
  schemaVersion: 3;
  projectId: string;
  documentPath: string;
  baseRevision: string;
  status: "active" | "completed";
  annotations: ReviewAnnotation[];
  chapterReviewRuns: ChapterReviewRun[];
  updatedAt: string;
}

export type AiStreamEvent =
  | { type: "started"; annotationId: string; engine: AiEngine }
  | { type: "progress"; annotationId: string; message: string }
  | { type: "result"; annotationId: string; engine: AiEngine; reply: string; suggestion?: AiSuggestion; anchorHash: string }
  | { type: "error"; message: string };

export type ChapterReviewStreamEvent =
  | { type: "started" | "local_result" | "audit_result" | "verifying" | "result"; run: ChapterReviewRun; message: string }
  | { type: "error"; message: string; run?: ChapterReviewRun };

export interface SearchResult extends DocumentEntry {
  snippet: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

export interface ProjectMutationResponse extends ProjectsResponse {
  project?: ProjectSummary;
  deleted?: {
    id: string;
    name: string;
    trashedPath?: string;
  };
}

export interface DeleteDocumentResponse {
  deleted: true;
  path: string;
  trashedPath: string;
}
