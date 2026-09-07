import { useEffect, useRef, useState } from "react";
import { fetchSearch } from "../lib/api";
import type { SearchResult } from "../types";

function errorMessage(caught: unknown) {
  return caught instanceof Error ? caught.message : "发生未知错误";
}

export function useLibrarySearch(input: {
  activeProjectId: string;
  query: string;
}) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const [resolvedKey, setResolvedKey] = useState("");
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([input.activeProjectId, input.query.trim(), attempt]);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const trimmedQuery = input.query.trim();
    if (!input.activeProjectId || !trimmedQuery) {
      setResults([]);
      setStatus("idle");
      setError("");
      return;
    }
    const controller = new AbortController();
    setResults([]);
    setStatus("loading");
    setError("");
    const timeout = window.setTimeout(() => {
      fetchSearch(input.activeProjectId, trimmedQuery, controller.signal)
        .then((payload) => {
          if (requestId !== requestIdRef.current || controller.signal.aborted) return;
          setResults(payload.results);
          setStatus("success");
          setResolvedKey(key);
        })
        .catch((caught) => {
          if (caught instanceof DOMException && caught.name === "AbortError") return;
          if (requestId !== requestIdRef.current || controller.signal.aborted) return;
          setError(errorMessage(caught));
          setStatus("error");
          setResolvedKey(key);
        });
    }, 260);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [input.activeProjectId, input.query, attempt]);

  const searching = Boolean(input.activeProjectId && input.query.trim());
  const pending = searching && resolvedKey !== key;
  return { inputRef, results: searching && !pending ? results : [], status: !searching ? "idle" as const : pending ? "loading" as const : status, error: pending ? "" : error, retry: () => setAttempt((value) => value + 1) };
}
