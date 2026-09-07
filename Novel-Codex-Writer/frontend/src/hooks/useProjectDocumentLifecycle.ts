import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { fetchDocument, fetchLibrary, fetchReviewSession } from "../lib/api";
import { prepareReviewSessionForDocument } from "../lib/review-session-migration";
import type { DocumentResponse, GroupId, LibraryResponse, ReviewSession, WorkflowStatus } from "../types";

import { readPreference, recentDocumentKey } from "../lib/preferences";

type Setter<T> = Dispatch<SetStateAction<T>>;

function errorMessage(caught: unknown) {
  return caught instanceof Error ? caught.message : "发生未知错误";
}

export function createContentLoadingTracker(onChange: (loading: boolean) => void) {
  let pending = 0;
  return () => {
    pending += 1;
    onChange(true);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      pending = Math.max(0, pending - 1);
      onChange(pending > 0);
    };
  };
}

export function useProjectLibraryLifecycle(input: {
  activeProjectId: string;
  selectedPath: string;
  setLibrary: Setter<LibraryResponse | undefined>;
  setWorkflowStatus: Setter<WorkflowStatus | undefined>;
  beginContentLoading(): () => void;
  setSelectedPath: Setter<string>;
  setOpenGroups: Setter<GroupId[]>;
  setError: Setter<string>;
  navigateToPath(path: string): void;
}) {
  const selectedPathRef = useRef(input.selectedPath);
  const navigateToPathRef = useRef(input.navigateToPath);
  selectedPathRef.current = input.selectedPath;
  navigateToPathRef.current = input.navigateToPath;

  useEffect(() => {
    input.setLibrary(undefined);
    input.setWorkflowStatus(undefined);
    if (!input.activeProjectId) {
      return;
    }
    const controller = new AbortController();
    const finishLoading = input.beginContentLoading();
    fetchLibrary(input.activeProjectId, controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        input.setLibrary(payload);
        const allEntries = payload.groups.flatMap((group) => group.entries);
        const currentPath = selectedPathRef.current;
        const retained = allEntries.find((entry) => entry.path === currentPath);
        const recentPath = readPreference(recentDocumentKey(input.activeProjectId));
        const recent = allEntries.find((entry) => entry.path === recentPath);
        const next = retained ?? recent ?? (recentPath ? undefined : payload.featured.latestChapter ?? payload.featured.context ?? allEntries[0]);
        if (next && !currentPath) navigateToPathRef.current(next.path);
        else input.setSelectedPath(next?.path ?? "");
        if (next) input.setOpenGroups((current) => current.includes(next.groupId) ? current : [...current, next.groupId]);
      })
      .catch((caught) => {
        if (controller.signal.aborted || (caught instanceof DOMException && caught.name === "AbortError")) return;
        input.setError(errorMessage(caught));
      })
      .finally(finishLoading);
    return () => {
      controller.abort();
      finishLoading();
    };
  }, [input.activeProjectId]);
}

export function useDocumentLifecycle(input: {
  activeProjectId: string;
  selectedPath: string;
  sessionLoadedRef: MutableRefObject<boolean>;
  setDocument: Setter<DocumentResponse | undefined>;
  setDraftContent: Setter<string>;
  setSession: Setter<ReviewSession | undefined>;
  setSelectedAnnotationId: Setter<string | undefined>;
  beginContentLoading(): () => void;
  setError: Setter<string>;
}) {
  useEffect(() => {
    if (!input.activeProjectId || !input.selectedPath) {
      input.setDocument(undefined);
      input.setDraftContent("");
      input.setSession(undefined);
      return;
    }
    const controller = new AbortController();
    input.sessionLoadedRef.current = false;
    input.setDocument(undefined);
    input.setDraftContent("");
    input.setSession(undefined);
    input.setSelectedAnnotationId(undefined);
    const finishLoading = input.beginContentLoading();
    Promise.all([
      fetchDocument(input.activeProjectId, input.selectedPath, controller.signal),
      fetchReviewSession(input.activeProjectId, input.selectedPath, controller.signal)
    ])
      .then(([documentPayload, sessionPayload]) => {
        if (controller.signal.aborted) return;
        input.setDocument(documentPayload);
        input.setDraftContent(documentPayload.content);
        input.setSession(prepareReviewSessionForDocument(sessionPayload, documentPayload.revision));
        input.setSelectedAnnotationId(sessionPayload.annotations[0]?.id);
        input.sessionLoadedRef.current = true;
      })
      .catch((caught) => {
        if (controller.signal.aborted || (caught instanceof DOMException && caught.name === "AbortError")) return;
        input.setError(errorMessage(caught));
      })
      .finally(finishLoading);
    return () => {
      controller.abort();
      finishLoading();
    };
  }, [input.activeProjectId, input.selectedPath]);
}
