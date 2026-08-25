import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { streamAiSuggestion } from "../lib/api";
import { createTextAnchor, getLineText } from "../lib/format";
import { isAnnotationProcessable } from "../lib/review";
import type {
  DocumentResponse,
  ReviewAnnotation,
  ReviewConversationMessage,
  ReviewSession
} from "../types";
import type { AiRequestController } from "./useAiRequestController";

function errorMessage(caught: unknown) {
  return caught instanceof Error ? caught.message : "发生未知错误";
}

export function useAnnotationAiController(input: {
  activeProjectId: string;
  selectedPath: string;
  session?: ReviewSession;
  document?: DocumentResponse;
  draftContent: string;
  dirty: boolean;
  aiRequestController: AiRequestController;
  draftVersionRef: MutableRefObject<number>;
  updateAnnotation(id: string, patch: Partial<ReviewAnnotation>): void;
  onNotice(message: string): void;
}) {
  const [batchBusy, setBatchBusy] = useState(false);
  const batchBusyRef = useRef(false);
  const batchRunIdRef = useRef(0);
  const draftContentRef = useRef("");
  const documentRef = useRef<DocumentResponse>();
  const sessionRef = useRef<ReviewSession>();
  const dirtyRef = useRef(false);
  const selectionKeyRef = useRef("");
  const callAiRef = useRef<(id: string, mode?: "new" | "retry") => Promise<void>>();
  draftContentRef.current = input.draftContent;
  documentRef.current = input.document;
  sessionRef.current = input.session;
  dirtyRef.current = input.dirty;
  selectionKeyRef.current = `${input.activeProjectId}:${input.selectedPath}`;

  useEffect(() => {
    batchRunIdRef.current += 1;
    batchBusyRef.current = false;
    setBatchBusy(false);
  }, [input.activeProjectId, input.selectedPath]);

  function reset() {
    batchRunIdRef.current += 1;
    batchBusyRef.current = false;
    setBatchBusy(false);
  }

  async function callAi(id: string, mode: "new" | "retry" = "new") {
    const liveSession = sessionRef.current;
    const liveDocument = documentRef.current;
    const liveDraft = draftContentRef.current;
    const annotation = liveSession?.annotations.find((item) => item.id === id);
    if (!annotation || !liveSession || !liveDocument) return;
    if (dirtyRef.current) {
      input.onNotice("请先保存当前草稿，再调用 AI；这样可以保证送审内容与磁盘 revision 一致。");
      return;
    }
    const draftVersion = input.draftVersionRef.current;
    const inFlightKey = `annotation:${liveSession.projectId}:${liveSession.documentPath}:${id}`;
    const currentOriginalText = getLineText(liveDraft, annotation.fromLine, annotation.toLine);
    const currentAnchorHash = createTextAnchor(liveDraft, annotation.fromLine, annotation.toLine);
    const anchorChanged = currentAnchorHash !== annotation.anchorHash;
    const existingMessages = anchorChanged ? [] : (annotation.messages ?? []);
    let question = annotation.comment.trim();
    let requestHistory = existingMessages;
    let visibleMessages = existingMessages;
    if (mode === "retry") {
      let lastUserIndex = -1;
      for (let index = existingMessages.length - 1; index >= 0; index -= 1) {
        if (existingMessages[index].role === "user") {
          lastUserIndex = index;
          break;
        }
      }
      if (lastUserIndex >= 0) {
        question = existingMessages[lastUserIndex].content;
        requestHistory = existingMessages.slice(0, lastUserIndex);
        visibleMessages = existingMessages.slice(0, lastUserIndex + 1);
      }
    }
    if (!question) return;
    const request = input.aiRequestController.start(inFlightKey);
    if (!request) return;
    if (mode === "new") {
      const userMessage: ReviewConversationMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: question,
        createdAt: new Date().toISOString()
      };
      visibleMessages = [...existingMessages, userMessage];
    }
    input.updateAnnotation(id, {
      comment: "",
      messages: visibleMessages,
      originalText: currentOriginalText,
      anchorHash: currentAnchorHash,
      suggestion: undefined,
      status: "running",
      error: undefined
    });
    try {
      await streamAiSuggestion({
        projectId: liveSession.projectId,
        documentPath: liveSession.documentPath,
        content: liveDraft,
        fromLine: annotation.fromLine,
        toLine: annotation.toLine,
        comment: question,
        engine: annotation.engine,
        annotationId: annotation.id,
        history: requestHistory,
        expectedRevision: liveDocument.revision,
        requestId: request.requestId
      }, (event) => {
        if (!input.aiRequestController.isCurrent(request) || draftVersion !== input.draftVersionRef.current) return;
        if (event.type === "result") {
          const assistantMessage: ReviewConversationMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: event.reply,
            suggestion: event.suggestion,
            engine: event.engine,
            createdAt: new Date().toISOString()
          };
          input.updateAnnotation(id, {
            status: "ready",
            messages: [...visibleMessages, assistantMessage],
            suggestion: event.suggestion,
            anchorHash: event.anchorHash
          });
        }
        if (event.type === "error") input.updateAnnotation(id, { status: "error", error: event.message });
      }, request.controller.signal);
    } catch (caught) {
      if (request.controller.signal.aborted || draftVersion !== input.draftVersionRef.current) return;
      input.updateAnnotation(id, { status: "error", error: errorMessage(caught) });
    } finally {
      input.aiRequestController.finish(request);
    }
  }

  callAiRef.current = callAi;

  async function processAll() {
    if (batchBusyRef.current) return;
    const runId = ++batchRunIdRef.current;
    batchBusyRef.current = true;
    setBatchBusy(true);
    const selectionKey = selectionKeyRef.current;
    const draftVersion = input.draftVersionRef.current;
    const queue = sessionRef.current?.annotations.filter(isAnnotationProcessable) ?? [];
    try {
      for (const annotation of queue) {
        if (selectionKey !== selectionKeyRef.current || draftVersion !== input.draftVersionRef.current) break;
        const latest = sessionRef.current?.annotations.find((item) => item.id === annotation.id);
        if (!latest) continue;
        await callAiRef.current?.(latest.id, latest.status === "error" && !latest.comment.trim() ? "retry" : "new");
      }
    } finally {
      if (batchRunIdRef.current !== runId) return;
      batchBusyRef.current = false;
      setBatchBusy(false);
    }
  }

  return { batchBusy, callAi, processAll, reset };
}
