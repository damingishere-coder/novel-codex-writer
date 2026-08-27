export type WorkflowState = "blocked" | "needs_changes" | "ready" | "finalized";
export type WorkflowArtifactState = "missing" | "ready" | "needs_changes" | "stale" | "blocked" | "finalized";
export type WorkflowRecommendedAction = "copy_to_codex" | "classify_patch" | "generate_taskbook" | "check_body" | "apply_patch";
export type WorkflowNextStepId =
  | "resolve_patch_classification"
  | "repair_taskbook"
  | "resolve_blocker"
  | "create_blueprint"
  | "generate_taskbook"
  | "draft_body"
  | "check_body"
  | "revise_body"
  | "create_commit"
  | "create_memory_patch"
  | "apply_patch"
  | "prepare_next_chapter";
export type WorkflowNextStepMode = "server_action" | "codex_prompt" | "confirm_action" | "open_panel";
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

export interface WorkflowNextStep {
  id: WorkflowNextStepId;
  mode: WorkflowNextStepMode;
  label: string;
  reason: string;
  serverAction?: "generate_taskbook" | "check_body" | "apply_patch" | "classify_patch";
  targetPath?: string;
  requiresConfirmation: boolean;
}

export interface WorkflowStatus {
  schemaVersion: 2;
  projectId: string;
  chapter: number;
  state: WorkflowState;
  artifacts: WorkflowArtifact[];
  recommendedAction: WorkflowRecommendedAction;
  recommendation: string;
  nextStep: WorkflowNextStep;
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

export type SystemPreflightState = "pass" | "warning" | "fail";

export interface SystemPreflightCheck {
  id: "node" | "npm" | "python" | "listener" | "library" | "registry" | "activeProject" | "transactions";
  label: string;
  state: SystemPreflightState;
  blocking: boolean;
  message: string;
}

export interface SystemPreflight {
  schemaVersion: 1;
  ready: boolean;
  runtime: {
    mode: "native" | "docker" | "custom";
    host: "127.0.0.1";
    port: number | null;
    nodeVersion: string;
    npmVersion?: string;
    pythonVersion?: string;
  };
  checks: SystemPreflightCheck[];
}

export interface MemoryOverviewRecord {
  id: string;
  category: string;
  status: string;
  importance: string;
  validFrom?: number;
  validTo?: number;
  entities: string[];
  tags: string[];
  sourceChapter?: number;
  updatedByPatch?: string;
  title: string;
  source: string;
  line: number;
  archived: boolean;
}

export interface MemoryChapterSummary {
  chapter: number;
  patchId: string;
  kind: string;
  chapterRevision?: string;
  summary: string;
  endingState: string;
}

export interface MemoryDiagnostic {
  code: "INDEX_MISSING" | "INDEX_INVALID" | "INDEX_STALE" | "TRANSACTION_PENDING";
  severity: "warning" | "error";
  message: string;
}

export interface MemoryOverview {
  schemaVersion: 1;
  projectId: string;
  indexStatus: "ready" | "missing" | "invalid" | "stale";
  records: MemoryOverviewRecord[];
  chapterSummaries: MemoryChapterSummary[];
  diagnostics: MemoryDiagnostic[];
}

export interface ProjectImportPreview {
  schemaVersion: 1;
  token: string;
  projectName: string;
  sourceProjectId: string;
  fileCount: number;
  totalBytes: number;
  warnings: string[];
}

export interface ProjectConsistencyIssue {
  code: "REQUIRED_DIRECTORY_MISSING" | "PROJECT_METADATA_INVALID" | "CHAPTER_DUPLICATE" | "MEMORY_INDEX_DIAGNOSTIC" | "PROJECT_SCAN_FAILED";
  severity: "warning" | "error";
  message: string;
  path?: string;
}

export interface ProjectConsistencyReport {
  schemaVersion: 1;
  projectId: string;
  status: "ready" | "warning" | "error";
  checkedFiles: number;
  issues: ProjectConsistencyIssue[];
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
