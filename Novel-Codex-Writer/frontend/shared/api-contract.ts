export type WorkflowState = "blocked" | "needs_changes" | "ready" | "finalized";
export type WorkflowArtifactState = "missing" | "ready" | "needs_changes" | "stale" | "blocked" | "finalized";

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
  recommendedAction: string;
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
