export type ReviewEngine = "deepseek" | "codex";

export interface ReviewReply {
  reply: string;
  suggestion?: {
    decision: "change" | "keep";
    severity: "S1" | "S2" | "S3" | "S4";
    category: string;
    before: string;
    after: string;
    rationale: string;
  };
}

export interface ReviewProvider {
  engine: ReviewEngine;
  model: string;
  requestReply(input: {
    system: string;
    user: string;
    combined: string;
    expectedBefore: string;
  }): Promise<ReviewReply>;
  requestJson(input: {
    system: string;
    user: string;
    combined: string;
    schemaFile: string;
    maxTokens: number;
  }): Promise<unknown>;
}
