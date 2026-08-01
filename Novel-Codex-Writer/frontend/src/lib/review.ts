import type { ReviewAnnotation, ReviewFinding } from "../types";

export function buildLineSelection(anchorLine: number | undefined, clickedLine: number, shiftKey: boolean) {
  if (!shiftKey || !anchorLine) return { fromLine: clickedLine, toLine: clickedLine };
  return {
    fromLine: Math.min(anchorLine, clickedLine),
    toLine: Math.max(anchorLine, clickedLine)
  };
}

export function findActiveAnnotationAtLine(annotations: ReviewAnnotation[], line: number) {
  return annotations.find((annotation) =>
    annotation.fromLine <= line &&
    annotation.toLine >= line &&
    annotation.status !== "accepted" &&
    annotation.status !== "ignored"
  );
}

export function reconcileAnnotationsAfterReplacement(
  annotations: ReviewAnnotation[],
  acceptedId: string,
  fromLine: number,
  toLine: number,
  insertedLineCount: number
) {
  const replacedLineCount = toLine - fromLine + 1;
  const delta = insertedLineCount - replacedLineCount;
  const now = new Date().toISOString();

  return annotations.map((annotation) => {
    if (annotation.id === acceptedId) return { ...annotation, status: "accepted" as const, updatedAt: now };
    if (annotation.status === "accepted" || annotation.status === "ignored") return annotation;
    if (annotation.fromLine <= toLine && annotation.toLine >= fromLine) {
      return {
        ...annotation,
        status: "stale" as const,
        error: "此处与另一条已采用建议重叠，需要重新分析。",
        updatedAt: now
      };
    }
    if (annotation.fromLine > toLine && delta !== 0) {
      return { ...annotation, fromLine: annotation.fromLine + delta, toLine: annotation.toLine + delta, updatedAt: now };
    }
    return annotation;
  });
}

export function reconcileAnnotationsAfterExternalReplacement(
  annotations: ReviewAnnotation[],
  fromLine: number,
  toLine: number,
  insertedLineCount: number
) {
  const delta = insertedLineCount - (toLine - fromLine + 1);
  const now = new Date().toISOString();
  return annotations.map((annotation) => {
    if (annotation.status === "accepted" || annotation.status === "ignored") return annotation;
    if (annotation.fromLine <= toLine && annotation.toLine >= fromLine) {
      return { ...annotation, status: "stale" as const, error: "整章体检建议已改动此处，原批注需要重新分析。", updatedAt: now };
    }
    if (annotation.fromLine > toLine && delta !== 0) {
      return { ...annotation, fromLine: annotation.fromLine + delta, toLine: annotation.toLine + delta, updatedAt: now };
    }
    return annotation;
  });
}

export function reconcileFindingsAfterReplacement(
  findings: ReviewFinding[],
  acceptedId: string,
  fromLine: number,
  toLine: number,
  insertedLineCount: number
) {
  const delta = insertedLineCount - (toLine - fromLine + 1);
  return findings.map((item) => {
    if (item.id === acceptedId) return { ...item, status: "accepted" as const };
    if (item.status === "accepted" || item.status === "dismissed") return item;
    if (item.fromLine === undefined || item.toLine === undefined) return item;
    if (item.fromLine <= toLine && item.toLine >= fromLine) return { ...item, status: "stale" as const };
    if (item.fromLine > toLine && delta !== 0) {
      return { ...item, fromLine: item.fromLine + delta, toLine: item.toLine + delta };
    }
    return item;
  });
}

export function computeChapterReviewVerdict(findings: ReviewFinding[]) {
  return findings.some((item) => (item.severity === "S1" || item.severity === "S2") && (item.status === "open" || item.status === "stale"))
    ? "needs_changes" as const
    : "pass" as const;
}
