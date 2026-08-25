import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { fetchSearch } from "../lib/api";
import type { SearchResult } from "../types";

function errorMessage(caught: unknown) {
  return caught instanceof Error ? caught.message : "发生未知错误";
}

export function useLibrarySearch(input: {
  activeProjectId: string;
  query: string;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
}) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);

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
    const timeout = window.setTimeout(() => {
      setResults([]);
      setStatus("loading");
      setError("");
      fetchSearch(input.activeProjectId, trimmedQuery, controller.signal)
        .then((payload) => {
          if (requestId !== requestIdRef.current || controller.signal.aborted) return;
          setResults(payload.results);
          setStatus("success");
        })
        .catch((caught) => {
          if (caught instanceof DOMException && caught.name === "AbortError") return;
          if (requestId !== requestIdRef.current || controller.signal.aborted) return;
          setError(errorMessage(caught));
          setStatus("error");
        });
    }, 260);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [input.activeProjectId, input.query]);

  useEffect(() => {
    function handleSearchShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        input.setSidebarCollapsed(false);
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handleSearchShortcut);
    return () => window.removeEventListener("keydown", handleSearchShortcut);
  }, [input.setSidebarCollapsed]);

  return { inputRef, results, status, error };
}
