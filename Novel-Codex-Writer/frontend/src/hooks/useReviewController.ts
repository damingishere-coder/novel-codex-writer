import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AnnotationRevealRequest } from "../components/NovelEditor";
import { exportReviewSession, fetchLibrary } from "../lib/api";
import { createTextAnchor, getLineText, replaceLineRange } from "../lib/format";
import {
  buildLineSelection,
  findActiveAnnotationAtLine,
  reconcileAnnotationsAfterReplacement,
  reconcileFindingsAfterReplacement
} from "../lib/review";
import type {
  AiStatus,
  DocumentEntry,
  DocumentResponse,
  LibraryResponse,
  ReviewAnnotation,
  ReviewSession,
  WorkspaceMode
} from "../types";
import { useAiRequestController } from "./useAiRequestController";
import { useAnnotationAiController } from "./useAnnotationAiController";
import { useChapterReviewController } from "./useChapterReviewController";

type Setter<T> = Dispatch<SetStateAction<T>>;

function errorMessage(caught: unknown) {
  return caught instanceof Error ? caught.message : "发生未知错误";
}

export function useReviewController(input: {
  activeProjectId: string;
  selectedPath: string;
  selectedEntry?: DocumentEntry;
  session?: ReviewSession;
  setSession: Setter<ReviewSession | undefined>;
  document?: DocumentResponse;
  draftContent: string;
  setDraftContent: Setter<string>;
  dirty: boolean;
  aiStatus?: AiStatus;
  setRightVisible: Setter<boolean>;
  setMode: Setter<WorkspaceMode>;
  setLibrary: Setter<LibraryResponse | undefined>;
  persistReviewSession(): Promise<ReviewSession | undefined>;
  getCurrentSession(): ReviewSession | undefined;
  onNotice(message: string): void;
}) {
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string>();
  const [annotationRevealRequest, setAnnotationRevealRequest] = useState<AnnotationRevealRequest>();
  const [lastClickedLine, setLastClickedLine] = useState<number>();
  const annotationRevealRequestIdRef = useRef(0);
  const draftVersionRef = useRef(0);
  const resettersRef = useRef<Array<() => void>>([]);
  const aiRequestController = useAiRequestController(`${input.activeProjectId}:${input.selectedPath}`);
  const selectionKeyRef = useRef("");
  selectionKeyRef.current = `${input.activeProjectId}:${input.selectedPath}`;

  useEffect(() => {
    setLastClickedLine(undefined);
    setAnnotationRevealRequest(undefined);
    setSelectedAnnotationId(undefined);
  }, [input.activeProjectId, input.selectedPath]);

  function invalidateDraftBoundRequests() {
    draftVersionRef.current += 1;
    aiRequestController.abortAll();
    for (const reset of resettersRef.current) reset();
  }

  function updateAnnotation(id: string, patch: Partial<ReviewAnnotation>) {
    input.setSession((current) => current ? {
      ...current,
      annotations: current.annotations.map((item) =>
        item.id === id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item
      )
    } : current);
  }

  function createAnnotation(fromLine: number, toLine: number) {
    if (!input.session) return;
    const now = new Date().toISOString();
    const annotation: ReviewAnnotation = {
      id: crypto.randomUUID(),
      fromLine,
      toLine,
      comment: "",
      messages: [],
      originalText: getLineText(input.draftContent, fromLine, toLine),
      engine: input.aiStatus?.settings.engine ?? "codex",
      status: "draft",
      anchorHash: createTextAnchor(input.draftContent, fromLine, toLine),
      createdAt: now,
      updatedAt: now
    };
    input.setSession((current) => current
      ? { ...current, annotations: [annotation, ...current.annotations] }
      : current);
    setSelectedAnnotationId(annotation.id);
  }

  function handleLineClick(line: number, shiftKey: boolean) {
    if (!input.session) return;
    input.setRightVisible(true);
    if (shiftKey && lastClickedLine) {
      const { fromLine, toLine } = buildLineSelection(lastClickedLine, line, true);
      const selected = input.session.annotations.find(
        (item) => item.id === selectedAnnotationId && item.status === "draft"
      );
      if (selected) {
        updateAnnotation(selected.id, {
          fromLine,
          toLine,
          originalText: getLineText(input.draftContent, fromLine, toLine),
          anchorHash: createTextAnchor(input.draftContent, fromLine, toLine)
        });
        return;
      }
      createAnnotation(fromLine, toLine);
      return;
    }
    setLastClickedLine(line);
    const existing = findActiveAnnotationAtLine(input.session.annotations, line);
    if (existing) {
      setSelectedAnnotationId(existing.id);
      return;
    }
    createAnnotation(line, line);
  }

  function selectAndRevealAnnotation(id: string) {
    annotationRevealRequestIdRef.current += 1;
    setSelectedAnnotationId(id);
    setAnnotationRevealRequest({ annotationId: id, requestId: annotationRevealRequestIdRef.current });
  }

  function handleAnnotationRevealHandled(requestId: number) {
    setAnnotationRevealRequest((current) => current?.requestId === requestId ? undefined : current);
  }

  function handleDraftChange(value: string) {
    if (value === input.draftContent) return;
    invalidateDraftBoundRequests();
    input.setDraftContent(value);
    input.setSession((current) => current ? {
      ...current,
      annotations: current.annotations.map((annotation) => annotation.status === "draft"
        ? annotation
        : { ...annotation, status: "stale" as const, error: "草稿已变化，需要重新分析。" }),
      chapterReviewRuns: current.chapterReviewRuns.map((run) => run.status === "stale"
        ? run
        : { ...run, status: "stale" as const, verdict: "stale" as const })
    } : current);
  }

  function acceptSuggestion(id: string) {
    const annotation = input.session?.annotations.find((item) => item.id === id);
    if (!annotation?.suggestion || !input.session) return;
    const currentText = getLineText(input.draftContent, annotation.fromLine, annotation.toLine);
    if (
      currentText !== annotation.suggestion.before
      || !annotation.suggestion.after.trim()
      || annotation.suggestion.after.length > 10_000
    ) {
      updateAnnotation(id, { status: "stale", error: "原文已经变化，需要重新分析后才能采用。" });
      return;
    }
    const nextDraft = replaceLineRange(
      input.draftContent,
      annotation.fromLine,
      annotation.toLine,
      annotation.suggestion.after
    );
    const insertedLines = annotation.suggestion.after.split(/\r?\n/).length;
    invalidateDraftBoundRequests();
    input.setDraftContent(nextDraft);
    input.setSession((current) => current ? {
      ...current,
      annotations: reconcileAnnotationsAfterReplacement(
        current.annotations,
        id,
        annotation.fromLine,
        annotation.toLine,
        insertedLines
      ),
      chapterReviewRuns: current.chapterReviewRuns.map((run) => ({
        ...run,
        status: "stale" as const,
        verdict: "stale" as const,
        findings: reconcileFindingsAfterReplacement(
          run.findings,
          "",
          annotation.fromLine,
          annotation.toLine,
          insertedLines
        )
      }))
    } : current);
    input.onNotice("建议已应用到当前草稿，点击“保存”后才会写入文件");
  }

  async function exportReview() {
    if (!input.session) return;
    const selectionKey = selectionKeyRef.current;
    try {
      const savedSession = await input.persistReviewSession();
      if (selectionKey !== selectionKeyRef.current) return;
      const current = savedSession ?? input.getCurrentSession() ?? input.session;
      const result = await exportReviewSession(current.projectId, current.documentPath);
      if (selectionKey !== selectionKeyRef.current) return;
      input.onNotice(`审校报告已导出：${result.path}`);
      const nextLibrary = await fetchLibrary(current.projectId);
      if (selectionKey === selectionKeyRef.current) input.setLibrary(nextLibrary);
    } catch (caught) {
      if (selectionKey === selectionKeyRef.current) input.onNotice(errorMessage(caught));
    }
  }

  function deleteAnnotation(id: string) {
    input.setSession((current) => current
      ? { ...current, annotations: current.annotations.filter((item) => item.id !== id) }
      : current);
    setSelectedAnnotationId(undefined);
  }

  function locateFinding(id: string) {
    selectAndRevealAnnotation(id);
    input.setMode("review");
  }

  const chapterReview = useChapterReviewController({
    activeProjectId: input.activeProjectId,
    selectedPath: input.selectedPath,
    selectedEntry: input.selectedEntry,
    session: input.session,
    setSession: input.setSession,
    document: input.document,
    draftContent: input.draftContent,
    setDraftContent: input.setDraftContent,
    dirty: input.dirty,
    setRightVisible: input.setRightVisible,
    aiRequestController,
    draftVersionRef,
    invalidateAll: invalidateDraftBoundRequests,
    onNotice: input.onNotice
  });
  const annotationAi = useAnnotationAiController({
    activeProjectId: input.activeProjectId,
    selectedPath: input.selectedPath,
    session: input.session,
    document: input.document,
    draftContent: input.draftContent,
    dirty: input.dirty,
    aiRequestController,
    draftVersionRef,
    updateAnnotation,
    onNotice: input.onNotice
  });
  resettersRef.current = [chapterReview.reset, annotationAi.reset];

  return {
    selectedAnnotationId,
    setSelectedAnnotationId,
    annotationRevealRequest,
    chapterReviewBusy: chapterReview.busy,
    batchReviewBusy: annotationAi.batchBusy,
    chapterReviewMessage: chapterReview.message,
    handleLineClick,
    handleAnnotationRevealHandled,
    selectAndRevealAnnotation,
    updateAnnotation,
    invalidateDraftBoundRequests,
    handleDraftChange,
    runChapterReview: chapterReview.run,
    acceptChapterFinding: chapterReview.acceptFinding,
    dismissChapterFinding: chapterReview.dismissFinding,
    callAi: annotationAi.callAi,
    processAll: annotationAi.processAll,
    acceptSuggestion,
    exportReview,
    deleteAnnotation,
    locateFinding
  };
}
