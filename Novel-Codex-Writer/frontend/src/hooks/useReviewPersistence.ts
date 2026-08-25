import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { saveReviewSession } from "../lib/api";
import type { ReviewSession } from "../types";

export function mergeSavedSessionRevision(
  latest: ReviewSession | undefined,
  saved: Pick<ReviewSession, "projectId" | "documentPath" | "sessionRevision" | "updatedAt">
) {
  if (!latest || latest.projectId !== saved.projectId || latest.documentPath !== saved.documentPath) {
    return latest;
  }
  return { ...latest, sessionRevision: saved.sessionRevision, updatedAt: saved.updatedAt };
}

export function persistencePayload(session: ReviewSession): ReviewSession {
  return {
    ...session,
    chapterReviewRuns: session.chapterReviewRuns.filter((run) => run.status !== "running")
  };
}

export function reviewSessionContentFingerprint(session: ReviewSession) {
  return JSON.stringify({
    baseRevision: session.baseRevision,
    status: session.status,
    annotations: session.annotations,
    chapterReviewRuns: persistencePayload(session).chapterReviewRuns
  });
}

export function useReviewPersistence(
  session: ReviewSession | undefined,
  setSession: Dispatch<SetStateAction<ReviewSession | undefined>>,
  loadedRef: MutableRefObject<boolean>,
  setNotice: Dispatch<SetStateAction<string>>
) {
  const sessionRef = useRef<ReviewSession>();
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  sessionRef.current = session;

  const flush = useCallback((): Promise<ReviewSession | undefined> => {
    const save = saveChainRef.current.then(async () => {
      let candidate = sessionRef.current;
      while (candidate && loadedRef.current) {
        try {
          const saved = await saveReviewSession({ ...persistencePayload(candidate), updatedAt: new Date().toISOString() });
          const current = sessionRef.current;
          if (current && current.projectId === saved.projectId && current.documentPath === saved.documentPath) {
            const changedWhileSaving = reviewSessionContentFingerprint(current) !== reviewSessionContentFingerprint(candidate);
            const merged = { ...current, sessionRevision: saved.sessionRevision, updatedAt: saved.updatedAt };
            sessionRef.current = merged;
            setSession((latest) => {
              const updated = mergeSavedSessionRevision(latest, saved);
              sessionRef.current = updated;
              return updated;
            });
            if (changedWhileSaving) {
              candidate = merged;
              continue;
            }
            return merged;
          }
          return current;
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : "发生未知错误";
          const current = sessionRef.current;
          if (
            current
            && current.projectId === candidate.projectId
            && current.documentPath === candidate.documentPath
          ) {
            setNotice(`批注暂未保存：${message}`);
          }
          throw caught;
        }
      }
      return candidate;
    });
    saveChainRef.current = save.then(() => undefined, () => undefined);
    return save;
  }, [loadedRef, setNotice, setSession]);

  useEffect(() => {
    if (!session || !loadedRef.current) return;
    const timeout = window.setTimeout(() => void flush().catch(() => undefined), 500);
    return () => window.clearTimeout(timeout);
  }, [flush, loadedRef, session?.annotations, session?.baseRevision, session?.chapterReviewRuns, session?.status]);

  return { flush, getCurrent: () => sessionRef.current };
}
