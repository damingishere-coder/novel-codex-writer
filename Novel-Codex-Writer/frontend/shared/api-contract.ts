export type WorkflowState = "blocked" | "needs_changes" | "ready" | "finalized";
export type WorkflowArtifactState = "missing" | "ready" | "needs_changes" | "stale" | "blocked" | "finalized";
export type WorkflowRecommendedAction = "copy_to_codex" | "classify_patch" | "generate_taskbook" | "check_body" | "apply_patch";
export type AiEngine = "deepseek" | "codex";
export type ReasoningEffort = "low" | "medium" | "high";

export interface WorkflowArtifact {
  id: "blueprint" | "taskbook" | "body" | "review" | "commit" | "memoryPatch";
  label: string;
  status: WorkflowArtifactState;
  path?: string;
  revision?: string;
  message: string;
}

export interface WorkflowContextItem {
  path: string;
  role: string;
  revision?: string;
  missing: boolean;
  stale: boolean;
}

export interface WorkflowStatus {
  schemaVersion: 1;
  projectId: string;
  chapter: number;
  state: WorkflowState;
  artifacts: WorkflowArtifact[];
  recommendedAction: WorkflowRecommendedAction;
  recommendation: string;
  reviewContext: WorkflowContextItem[];
  legacyPatchChoices: string[];
}

export interface DocumentVersion {
  id: string;
  revision: string;
  createdAt: string;
  size: number;
}

export interface VersionsResponse {
  path: string;
  currentRevision: string;
  versions: DocumentVersion[];
}

export interface VersionDiff {
  versionId: string;
  historicalRevision: string;
  currentRevision: string;
  before: string;
  after: string;
  fromLine: number;
}

export interface TrashEntry {
  id: string;
  path: string;
  trashedPath: string;
  deletedAt: string;
  size: number;
}

export interface TrashRestoreResponse {
  restored: true;
  path: string;
  recoveryArchived: boolean;
}

export interface ApiStreamError {
  type: "error";
  code: string;
  message: string;
}

export type AiStreamEnvelope<TSuggestion = unknown> =
  | { type: "started"; annotationId: string; engine: AiEngine }
  | { type: "progress"; annotationId: string; message: string }
  | { type: "result"; annotationId: string; engine: AiEngine; reply: string; suggestion?: TSuggestion; anchorHash: string }
  | ApiStreamError;

export type ChapterReviewStreamEnvelope<TRun> =
  | { type: "started" | "local_result" | "audit_result" | "verifying" | "result"; run: TRun; message: string }
  | (ApiStreamError & { run?: TRun });
