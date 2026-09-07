import type { ReviewAnnotation, ReviewConversationMessage, ReviewSession } from "../types";

export function prepareReviewSessionForDocument(session: ReviewSession, revision: string): ReviewSession {
  const documentChanged = Boolean(session.baseRevision && session.baseRevision !== revision);
  return {
    ...session,
    baseRevision: revision,
    annotations: session.annotations.map((annotation) => {
      const migrated = migrateReviewAnnotation(annotation);
      return documentChanged ? {
        ...migrated,
        status: "stale" as const,
        suggestion: undefined,
        error: "正文版本已变化，历史批注已保留，请重新分析后再采用。"
      } : migrated;
    }),
    chapterReviewRuns: session.chapterReviewRuns.map((run) => run.documentRevision === revision
      ? run
      : { ...run, status: "stale" as const, verdict: "stale" as const })
  };
}

export function migrateReviewAnnotation(annotation: ReviewAnnotation): ReviewAnnotation {
  if (Array.isArray(annotation.messages)) {
    return {
      ...annotation,
      messages: annotation.messages.map((message) =>
        message.id === `${annotation.id}-legacy-assistant` && message.suggestion
          ? {
              ...message,
              content: message.suggestion.decision === "keep"
                ? "这段原文可以保留。"
                : "我根据你的要求给出了一版可直接替换的文本。"
            }
          : message
      )
    };
  }
  if (!annotation.suggestion) return { ...annotation, messages: [] };
  const createdAt = annotation.updatedAt || annotation.createdAt;
  const messages: ReviewConversationMessage[] = [];
  if (annotation.comment.trim()) {
    messages.push({ id: `${annotation.id}-legacy-user`, role: "user", content: annotation.comment.trim(), createdAt: annotation.createdAt });
  }
  messages.push({
    id: `${annotation.id}-legacy-assistant`,
    role: "assistant",
    content: annotation.suggestion.decision === "keep" ? "这段原文可以保留。" : "我根据你的要求给出了一版可直接替换的文本。",
    suggestion: annotation.suggestion,
    engine: annotation.engine,
    createdAt
  });
  return { ...annotation, comment: "", messages };
}
