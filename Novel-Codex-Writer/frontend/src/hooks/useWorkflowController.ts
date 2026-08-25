import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { fetchLibrary, fetchWorkflowStatus, runWorkflowAction } from "../lib/api";
import type { LibraryResponse, WorkflowStatus } from "../types";

function errorMessage(caught: unknown) {
  return caught instanceof Error ? caught.message : "发生未知错误";
}

export function useWorkflowController(input: {
  activeProjectId: string;
  chapterNumber?: number;
  libraryGeneratedAt?: string;
  libraryReady: boolean;
  setLibrary: Dispatch<SetStateAction<LibraryResponse | undefined>>;
  onNotice(message: string): void;
}) {
  const [status, setStatus] = useState<WorkflowStatus>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const refreshRequestIdRef = useRef(0);
  const refreshControllerRef = useRef<AbortController>();
  const actionRequestIdRef = useRef(0);
  const actionControllerRef = useRef<AbortController>();
  const activeProjectIdRef = useRef(input.activeProjectId);
  const workflowKeyRef = useRef("");
  activeProjectIdRef.current = input.activeProjectId;
  workflowKeyRef.current = `${input.activeProjectId}:${input.chapterNumber ?? ""}`;

  useEffect(() => {
    setStatus(undefined);
    refreshControllerRef.current?.abort();
    if (!input.activeProjectId || !input.libraryReady) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    const requestId = ++refreshRequestIdRef.current;
    const workflowKey = workflowKeyRef.current;
    setLoading(true);
    fetchWorkflowStatus(input.activeProjectId, input.chapterNumber, controller.signal)
      .then((nextStatus) => {
        if (
          requestId === refreshRequestIdRef.current
          && workflowKey === workflowKeyRef.current
          && nextStatus.projectId === activeProjectIdRef.current
        ) {
          setStatus(nextStatus);
        }
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        if (
          requestId === refreshRequestIdRef.current
          && workflowKey === workflowKeyRef.current
          && input.activeProjectId === activeProjectIdRef.current
        ) {
          input.onNotice(`创作进度暂不可用：${errorMessage(caught)}`);
        }
      })
      .finally(() => {
        if (refreshControllerRef.current === controller) refreshControllerRef.current = undefined;
        if (
          !controller.signal.aborted
          && requestId === refreshRequestIdRef.current
          && workflowKey === workflowKeyRef.current
        ) setLoading(false);
      });
    return () => {
      controller.abort();
      if (refreshControllerRef.current === controller) refreshControllerRef.current = undefined;
    };
  }, [input.activeProjectId, input.chapterNumber, input.libraryGeneratedAt, input.libraryReady]);

  useEffect(() => {
    actionControllerRef.current?.abort();
    actionControllerRef.current = undefined;
    actionRequestIdRef.current += 1;
    setBusy(false);
    return () => actionControllerRef.current?.abort();
  }, [input.activeProjectId, input.chapterNumber]);

  const refresh = useCallback(async () => {
    if (!input.activeProjectId || !input.libraryReady) return;
    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    const requestId = ++refreshRequestIdRef.current;
    const workflowKey = workflowKeyRef.current;
    setLoading(true);
    try {
      const nextStatus = await fetchWorkflowStatus(input.activeProjectId, input.chapterNumber, controller.signal);
      if (requestId === refreshRequestIdRef.current && workflowKey === workflowKeyRef.current) {
        setStatus(nextStatus);
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      if (requestId === refreshRequestIdRef.current && workflowKey === workflowKeyRef.current) {
        input.onNotice(errorMessage(caught));
      }
    } finally {
      if (refreshControllerRef.current === controller) refreshControllerRef.current = undefined;
      if (requestId === refreshRequestIdRef.current && workflowKey === workflowKeyRef.current) setLoading(false);
    }
  }, [input.activeProjectId, input.chapterNumber, input.libraryReady, input.onNotice]);

  const runAction = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    if (!input.activeProjectId || !status || status.projectId !== input.activeProjectId) return;
    actionControllerRef.current?.abort();
    const controller = new AbortController();
    actionControllerRef.current = controller;
    const requestId = ++actionRequestIdRef.current;
    const projectId = input.activeProjectId;
    const workflowKey = workflowKeyRef.current;
    setBusy(true);
    try {
      const result = await runWorkflowAction(
        projectId,
        { action, chapter: status.chapter, ...extra },
        controller.signal
      );
      if (requestId !== actionRequestIdRef.current || workflowKey !== workflowKeyRef.current) return;
      setStatus(result.status);
      if (action === "generate_taskbook" || action === "check_body" || action === "apply_patch") {
        const nextLibrary = await fetchLibrary(projectId, controller.signal);
        if (requestId !== actionRequestIdRef.current || projectId !== activeProjectIdRef.current) return;
        input.setLibrary(nextLibrary);
      }
      input.onNotice(result.output?.trim().split(/\r?\n/).at(-1) ?? "工作流动作已完成");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      if (requestId === actionRequestIdRef.current && workflowKey === workflowKeyRef.current) {
        input.onNotice(errorMessage(caught));
      }
    } finally {
      if (actionControllerRef.current === controller) actionControllerRef.current = undefined;
      if (requestId === actionRequestIdRef.current) setBusy(false);
    }
  }, [input.activeProjectId, input.onNotice, input.setLibrary, status]);

  return { status, setStatus, loading, busy, refresh, runAction };
}
