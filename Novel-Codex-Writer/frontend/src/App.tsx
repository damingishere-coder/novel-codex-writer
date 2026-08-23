import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  Circle,
  FilePlus2,
  FolderCog,
  Eye,
  EyeOff,
  LoaderCircle,
  Menu,
  Moon,
  PanelRightOpen,
  PencilLine,
  Plus,
  Save,
  Search,
  Settings2,
  Sun,
  Trash2,
  X
} from "lucide-react";
import { LibrarySidebar } from "./components/LibrarySidebar";
import { RecoveryPanel } from "./components/RecoveryPanel";
import { WorkflowPanel } from "./components/WorkflowPanel";
import type { AnnotationRevealRequest } from "./components/NovelEditor";
import {
  createProject,
  deleteDocument,
  deleteProject,
  exportReviewSession,
  fetchAiStatus,
  fetchDocument,
  fetchLibrary,
  fetchProjects,
  fetchReviewSession,
  fetchWorkflowStatus,
  fetchSearch,
  saveDocument,
  saveDocumentRevision,
  saveReviewSession,
  runWorkflowAction,
  streamAiSuggestion,
  streamChapterReview,
  updateAiSettings,
  updateProject
} from "./lib/api";
import {
  CHAPTER_WORD_COUNT_MAX,
  CHAPTER_WORD_COUNT_MIN,
  cn,
  countReadableWords,
  createTextAnchor,
  formatWordCount,
  getChapterWordCountStatus,
  getLineText,
  replaceLineRange
} from "./lib/format";
import {
  COMPACT_LAYOUT_MAX_WIDTH,
  DEFAULT_PANE_WIDTHS,
  PANE_WIDTH_LIMITS,
  clampPaneWidth,
  fitPaneWidths,
  readStoredPaneWidth,
  type PaneSide,
  type PaneWidths
} from "./lib/pane-layout";
import {
  buildLineSelection,
  computeChapterReviewVerdict,
  findActiveAnnotationAtLine,
  reconcileAnnotationsAfterExternalReplacement,
  reconcileAnnotationsAfterReplacement,
  reconcileFindingsAfterReplacement
} from "./lib/review";
import type {
  AiEngine,
  AiSettings,
  AiSettingsUpdate,
  AiStatus,
  ChapterReviewRun,
  DocumentEntry,
  DocumentResponse,
  GroupId,
  LibraryResponse,
  ProjectSummary,
  ReviewAnnotation,
  ReviewConversationMessage,
  ReviewSession,
  SearchResult,
  WorkspaceMode
  ,WorkflowStatus
} from "./types";

const MarkdownView = lazy(() => import("./components/MarkdownView").then((module) => ({ default: module.MarkdownView })));
const NovelEditor = lazy(() => import("./components/NovelEditor").then((module) => ({ default: module.NovelEditor })));
const ReviewPanel = lazy(() => import("./components/ReviewPanel").then((module) => ({ default: module.ReviewPanel })));

const initialOpenGroups: GroupId[] = ["chapters", "current"];
const LEFT_PANE_STORAGE_KEY = "novel-left-pane-width";
const REVIEW_PANE_STORAGE_KEY = "novel-review-pane-width";

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState("");
  const [library, setLibrary] = useState<LibraryResponse>();
  const [selectedPath, setSelectedPath] = useState("");
  const [document, setDocument] = useState<DocumentResponse>();
  const [draftContent, setDraftContent] = useState("");
  const [mode, setMode] = useState<WorkspaceMode>("review");
  const [session, setSession] = useState<ReviewSession>();
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string>();
  const [annotationRevealRequest, setAnnotationRevealRequest] = useState<AnnotationRevealRequest>();
  const [chapterReviewBusy, setChapterReviewBusy] = useState(false);
  const [chapterReviewMessage, setChapterReviewMessage] = useState("");
  const [aiStatus, setAiStatus] = useState<AiStatus>();
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [searchError, setSearchError] = useState("");
  const [leftCollapsed, setLeftCollapsed] = useState(() => localStorage.getItem("novel-left-collapsed") === "true");
  const [rightVisible, setRightVisible] = useState(true);
  const [rightTab, setRightTab] = useState<"review" | "workflow" | "recovery">("review");
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus>();
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [documentHistory, setDocumentHistory] = useState<string[]>([]);
  const [documentHistoryIndex, setDocumentHistoryIndex] = useState(-1);
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(() => ({
    left: readStoredPaneWidth(localStorage.getItem(LEFT_PANE_STORAGE_KEY), "left"),
    right: readStoredPaneWidth(localStorage.getItem(REVIEW_PANE_STORAGE_KEY), "right")
  }));
  const [workbenchWidth, setWorkbenchWidth] = useState(0);
  const [openGroups, setOpenGroups] = useState<GroupId[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("novel-open-groups") ?? "null") ?? initialOpenGroups;
    } catch {
      return initialOpenGroups;
    }
  });
  const [dark, setDark] = useState(() => localStorage.getItem("novel-theme") === "dark");
  const [loading, setLoading] = useState(true);
  const [contentLoading, setContentLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [deleteDocumentOpen, setDeleteDocumentOpen] = useState(false);
  const [lastClickedLine, setLastClickedLine] = useState<number>();
  const sessionLoadedRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const annotationRevealRequestIdRef = useRef(0);
  const workbenchRef = useRef<HTMLElement>(null);
  const aiRequestsRef = useRef(new Set<AbortController>());
  const activeDocumentKeyRef = useRef("");
  const sessionRef = useRef<ReviewSession>();
  const sessionSaveInFlightRef = useRef(false);
  const sessionSavePendingRef = useRef(false);

  const activeProject = projects.find((project) => project.id === activeProjectId);
  const selectedEntry = library?.groups.flatMap((group) => group.entries).find((entry) => entry.path === selectedPath);
  activeDocumentKeyRef.current = `${activeProjectId}:${selectedPath}`;
  sessionRef.current = session;
  const wordCount = useMemo(() => countReadableWords(draftContent), [draftContent]);
  const dirty = Boolean(document && normalizeLineEndings(draftContent) !== normalizeLineEndings(document.content));
  const latestChapterReview = session?.chapterReviewRuns[0];
  const editorMarks = useMemo(() => [
    ...(session?.annotations ?? []).map(({ id, fromLine, toLine }) => ({ id, fromLine, toLine })),
    ...(latestChapterReview?.findings ?? [])
      .filter((item) => item.fromLine !== undefined && item.toLine !== undefined)
      .map((item) => ({ id: item.id, fromLine: item.fromLine!, toLine: item.toLine! }))
  ], [session?.annotations, latestChapterReview?.findings]);
  const effectivePaneWidths = useMemo(() => fitPaneWidths(paneWidths, {
    containerWidth: workbenchWidth,
    leftCollapsed,
    rightVisible
  }), [paneWidths, workbenchWidth, leftCollapsed, rightVisible]);
  const workbenchStyle = {
    "--left-pane-width": `${effectivePaneWidths.left}px`,
    "--review-pane-width": `${effectivePaneWidths.right}px`
  } as CSSProperties;

  useEffect(() => {
    globalThis.document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("novel-theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    localStorage.setItem("novel-left-collapsed", String(leftCollapsed));
    localStorage.setItem("novel-open-groups", JSON.stringify(openGroups));
  }, [leftCollapsed, openGroups]);

  useEffect(() => {
    localStorage.setItem(LEFT_PANE_STORAGE_KEY, String(paneWidths.left));
    localStorage.setItem(REVIEW_PANE_STORAGE_KEY, String(paneWidths.right));
  }, [paneWidths]);

  useEffect(() => {
    void initialize();
  }, []);

  useEffect(() => {
    const workbench = workbenchRef.current;
    if (!workbench || loading) return;
    const updateWidth = () => setWorkbenchWidth(workbench.getBoundingClientRect().width);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(workbench);
    return () => observer.disconnect();
  }, [loading]);

  const handlePaneWidthChange = useCallback((side: PaneSide, requestedWidth: number) => {
    const containerWidth = workbenchRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    setPaneWidths((current) => {
      const effective = fitPaneWidths(current, {
        containerWidth,
        leftCollapsed,
        rightVisible
      });
      const resizeHandleCount = Number(!leftCollapsed) + Number(rightVisible);
      const otherPaneWidth = side === "left"
        ? (rightVisible ? effective.right : 0)
        : (leftCollapsed ? 58 : effective.left);
      return {
        ...current,
        [side]: clampPaneWidth(side, requestedWidth, {
          containerWidth,
          otherPaneWidth,
          resizeHandleCount,
          compact: containerWidth <= COMPACT_LAYOUT_MAX_WIDTH
        })
      };
    });
  }, [leftCollapsed, rightVisible]);

  async function initialize() {
    try {
      setLoading(true);
      const projectPayload = await fetchProjects();
      setProjects(projectPayload.projects);
      setActiveProjectId(projectPayload.activeProjectId ?? projectPayload.projects[0]?.id ?? "");
    } catch (caught) {
      setError(getError(caught));
    } finally {
      setLoading(false);
    }
    void fetchAiStatus()
      .then(setAiStatus)
      .catch((caught) => setNotice(`AI 暂不可用，普通编辑不受影响：${getError(caught)}`));
  }

  useEffect(() => {
    if (!activeProjectId) {
      setLibrary(undefined);
      setWorkflowStatus(undefined);
      return;
    }
    let cancelled = false;
    setContentLoading(true);
    fetchLibrary(activeProjectId)
      .then((payload) => {
        if (cancelled) return;
        setLibrary(payload);
        const allEntries = payload.groups.flatMap((group) => group.entries);
        const retained = allEntries.find((entry) => entry.path === selectedPath);
        const next = retained ?? payload.featured.latestChapter ?? payload.featured.context ?? allEntries[0];
        if (next && !selectedPath) navigateToPath(next.path);
        else setSelectedPath(next?.path ?? "");
        if (next && !openGroups.includes(next.groupId)) setOpenGroups((current) => [...current, next.groupId]);
      })
      .catch((caught) => setError(getError(caught)))
      .finally(() => !cancelled && setContentLoading(false));
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) return;
    const controller = new AbortController();
    setWorkflowLoading(true);
    fetchWorkflowStatus(activeProjectId, selectedEntry?.chapterNumber, controller.signal)
      .then(setWorkflowStatus)
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setNotice(`创作进度暂不可用：${getError(caught)}`);
      })
      .finally(() => !controller.signal.aborted && setWorkflowLoading(false));
    return () => controller.abort();
  }, [activeProjectId, selectedEntry?.chapterNumber, library?.generatedAt]);

  useEffect(() => {
    if (!activeProjectId || !selectedPath) {
      setDocument(undefined);
      setDraftContent("");
      setSession(undefined);
      return;
    }
    const controller = new AbortController();
    sessionLoadedRef.current = false;
    setContentLoading(true);
    for (const active of aiRequestsRef.current) active.abort();
    aiRequestsRef.current.clear();
    Promise.all([
      fetchDocument(activeProjectId, selectedPath, controller.signal),
      fetchReviewSession(activeProjectId, selectedPath, controller.signal)
    ])
      .then(([documentPayload, sessionPayload]) => {
        if (controller.signal.aborted) return;
        setDocument(documentPayload);
        setDraftContent(documentPayload.content);
        setSession({
          ...sessionPayload,
          annotations: sessionPayload.annotations.map(migrateReviewAnnotation),
          baseRevision: sessionPayload.baseRevision || documentPayload.revision,
          chapterReviewRuns: sessionPayload.chapterReviewRuns.map((run) => run.documentRevision === documentPayload.revision
            ? run
            : { ...run, status: "stale" as const, verdict: "stale" as const })
        });
        setSelectedAnnotationId(sessionPayload.annotations[0]?.id);
        sessionLoadedRef.current = true;
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(getError(caught));
      })
      .finally(() => !controller.signal.aborted && setContentLoading(false));
    return () => {
      controller.abort();
    };
  }, [activeProjectId, selectedPath]);

  useEffect(() => {
    if (!session || !sessionLoadedRef.current) return;
    const timeout = window.setTimeout(() => {
      void persistReviewSession();
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [session?.annotations, session?.chapterReviewRuns, session?.status]);

  async function persistReviewSession() {
    if (sessionSaveInFlightRef.current) {
      sessionSavePendingRef.current = true;
      return;
    }
    const candidate = sessionRef.current;
    if (!candidate || !sessionLoadedRef.current) return;
    sessionSaveInFlightRef.current = true;
    try {
      const saved = await saveReviewSession({ ...candidate, updatedAt: new Date().toISOString() });
      const current = sessionRef.current;
      if (current && current.projectId === saved.projectId && current.documentPath === saved.documentPath) {
        const merged = { ...current, sessionRevision: saved.sessionRevision, updatedAt: saved.updatedAt };
        sessionRef.current = merged;
        setSession(merged);
      }
    } catch (caught) {
      setNotice(`批注暂未保存：${getError(caught)}`);
    } finally {
      sessionSaveInFlightRef.current = false;
      if (sessionSavePendingRef.current) {
        sessionSavePendingRef.current = false;
        void persistReviewSession();
      }
    }
  }

  useEffect(() => {
    const trimmedQuery = query.trim();
    if (!activeProjectId || !trimmedQuery) {
      setSearchResults([]);
      setSearchStatus("idle");
      setSearchError("");
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setSearchResults([]);
      setSearchStatus("loading");
      setSearchError("");
      fetchSearch(activeProjectId, trimmedQuery, controller.signal)
        .then((payload) => {
          setSearchResults(payload.results);
          setSearchStatus("success");
        })
        .catch((caught) => {
          if (caught instanceof DOMException && caught.name === "AbortError") return;
          setSearchError(getError(caught));
          setSearchStatus("error");
        });
    }, 260);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [activeProjectId, query]);

  useEffect(() => {
    function handleSearchShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setLeftCollapsed(false);
        searchInputRef.current?.focus();
      }
    }

    window.addEventListener("keydown", handleSearchShortcut);
    return () => window.removeEventListener("keydown", handleSearchShortcut);
  }, []);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3200);
  }, []);

  const handleAnnotationRevealHandled = useCallback((requestId: number) => {
    setAnnotationRevealRequest((current) => current?.requestId === requestId ? undefined : current);
  }, []);

  function navigateToPath(path: string, record = true) {
    if (record) {
      setDocumentHistory((current) => {
        const retained = current.slice(0, documentHistoryIndex + 1);
        if (retained.at(-1) === path) return retained;
        const next = [...retained, path].slice(-50);
        setDocumentHistoryIndex(next.length - 1);
        return next;
      });
    }
    setSelectedPath(path);
  }

  function navigateDocumentHistory(direction: -1 | 1) {
    const nextIndex = documentHistoryIndex + direction;
    const nextPath = documentHistory[nextIndex];
    if (!nextPath || (dirty && !window.confirm("当前草稿还没有保存。确定离开吗？"))) return;
    setDocumentHistoryIndex(nextIndex);
    navigateToPath(nextPath, false);
    const entry = library?.groups.flatMap((group) => group.entries).find((item) => item.path === nextPath);
    setMode(entry?.groupId === "chapters" ? "review" : "preview");
  }

  async function refreshWorkflow() {
    if (!activeProjectId) return;
    setWorkflowLoading(true);
    try {
      setWorkflowStatus(await fetchWorkflowStatus(activeProjectId, selectedEntry?.chapterNumber));
    } finally {
      setWorkflowLoading(false);
    }
  }

  async function handleWorkflowAction(action: string, extra: Record<string, unknown> = {}) {
    if (!activeProjectId || !workflowStatus) return;
    setWorkflowBusy(true);
    try {
      const result = await runWorkflowAction(activeProjectId, { action, chapter: workflowStatus.chapter, ...extra });
      setWorkflowStatus(result.status);
      if (action === "generate_taskbook" || action === "check_body" || action === "apply_patch") {
        setLibrary(await fetchLibrary(activeProjectId));
      }
      showNotice(result.output?.trim().split(/\r?\n/).at(-1) ?? "工作流动作已完成");
    } catch (caught) {
      showNotice(getError(caught));
    } finally {
      setWorkflowBusy(false);
    }
  }

  function selectEntry(entry: DocumentEntry) {
    if (dirty && !window.confirm("当前草稿还没有保存。确定切换文档吗？")) return;
    navigateToPath(entry.path);
    setQuery("");
    setMode(entry.groupId === "chapters" ? "review" : "preview");
  }

  async function switchProject(projectId: string) {
    if (dirty && !window.confirm("当前草稿还没有保存。确定切换小说吗？")) return;
    try {
      await updateProject(projectId, { active: true });
      setActiveProjectId(projectId);
      setSelectedPath("");
      setDocumentHistory([]);
      setDocumentHistoryIndex(-1);
    } catch (caught) {
      showNotice(getError(caught));
    }
  }

  async function handleSave() {
    if (!document || !activeProjectId) return;
    try {
      setSaving(true);
      const saved = await saveDocumentRevision(activeProjectId, document.path, draftContent, document.revision);
      setDocument(saved);
      setSession((current) => (current ? { ...current, baseRevision: saved.revision } : current));
      const nextLibrary = await fetchLibrary(activeProjectId);
      setLibrary(nextLibrary);
      showNotice("正文已保存，批注锚点已同步");
    } catch (caught) {
      setError(getError(caught));
    } finally {
      setSaving(false);
    }
  }

  function handleLineClick(line: number, shiftKey: boolean) {
    if (!session) return;
    setRightVisible(true);
    if (shiftKey && lastClickedLine) {
      const { fromLine, toLine } = buildLineSelection(lastClickedLine, line, true);
      const selected = session.annotations.find((item) => item.id === selectedAnnotationId && item.status === "draft");
      if (selected) {
        updateAnnotation(selected.id, {
          fromLine,
          toLine,
          originalText: getLineText(draftContent, fromLine, toLine),
          anchorHash: createTextAnchor(draftContent, fromLine, toLine)
        });
        return;
      }
      createAnnotation(fromLine, toLine);
      return;
    }
    setLastClickedLine(line);
    const existing = findActiveAnnotationAtLine(session.annotations, line);
    if (existing) {
      setSelectedAnnotationId(existing.id);
      return;
    }
    createAnnotation(line, line);
  }

  function selectAndRevealAnnotation(id: string) {
    annotationRevealRequestIdRef.current += 1;
    setSelectedAnnotationId(id);
    setAnnotationRevealRequest({
      annotationId: id,
      requestId: annotationRevealRequestIdRef.current
    });
  }

  function createAnnotation(fromLine: number, toLine: number) {
    if (!session) return;
    const now = new Date().toISOString();
    const annotation: ReviewAnnotation = {
      id: crypto.randomUUID(),
      fromLine,
      toLine,
      comment: "",
      messages: [],
      originalText: getLineText(draftContent, fromLine, toLine),
      engine: aiStatus?.settings.engine ?? "codex",
      status: "draft",
      anchorHash: createTextAnchor(draftContent, fromLine, toLine),
      createdAt: now,
      updatedAt: now
    };
    setSession({ ...session, annotations: [annotation, ...session.annotations] });
    setSelectedAnnotationId(annotation.id);
  }

  function updateAnnotation(id: string, patch: Partial<ReviewAnnotation>) {
    setSession((current) =>
      current
        ? {
            ...current,
            annotations: current.annotations.map((item) =>
              item.id === id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item
            )
          }
        : current
    );
  }

  function upsertChapterReviewRun(run: ChapterReviewRun) {
    setSession((current) => current ? {
      ...current,
      chapterReviewRuns: [run, ...current.chapterReviewRuns.filter((item) => item.id !== run.id)].slice(0, 20)
    } : current);
  }

  function handleDraftChange(value: string) {
    if (value === draftContent) return;
    setDraftContent(value);
    setSession((current) => current ? {
      ...current,
      chapterReviewRuns: current.chapterReviewRuns.map((run) => run.status === "stale" ? run : ({ ...run, status: "stale" as const, verdict: "stale" as const }))
    } : current);
  }

  async function runChapterReview(engine: AiEngine) {
    if (!session || selectedEntry?.groupId !== "chapters") return;
    setRightVisible(true);
    setChapterReviewBusy(true);
    setChapterReviewMessage("正在运行本地确定性检查……");
    const requestKey = `${session.projectId}:${session.documentPath}`;
    const controller = new AbortController();
    aiRequestsRef.current.add(controller);
    try {
      await streamChapterReview({
        projectId: session.projectId,
        documentPath: session.documentPath,
        content: draftContent,
        engine
      }, (event) => {
        if (controller.signal.aborted || activeDocumentKeyRef.current !== requestKey) return;
        setChapterReviewMessage(event.message);
        if (event.run) upsertChapterReviewRun(event.run);
        if (event.type === "error") showNotice(event.message);
      }, controller.signal);
    } catch (caught) {
      if (controller.signal.aborted) return;
      const message = getError(caught);
      setChapterReviewMessage(message);
      showNotice(message);
    } finally {
      aiRequestsRef.current.delete(controller);
      setChapterReviewBusy(false);
    }
  }

  function acceptChapterFinding(id: string) {
    if (!session) return;
    const reviewRun = session.chapterReviewRuns.find((run) => run.findings.some((item) => item.id === id));
    const target = reviewRun?.findings.find((item) => item.id === id);
    if (!reviewRun || !target?.after || !target.before || target.fromLine === undefined || target.toLine === undefined) return;
    const currentText = getLineText(draftContent, target.fromLine, target.toLine);
    if (currentText !== target.before) {
      setSession({
        ...session,
        chapterReviewRuns: session.chapterReviewRuns.map((run) => run.id !== reviewRun.id ? run : {
          ...run,
          status: "stale",
          verdict: "stale",
          findings: run.findings.map((item) => item.id === id ? { ...item, status: "stale" } : item)
        })
      });
      showNotice("这条建议对应的原文已经变化，已禁止采用；请重新体检。");
      return;
    }

    const nextDraft = replaceLineRange(draftContent, target.fromLine, target.toLine, target.after);
    const insertedLineCount = target.after.split(/\r?\n/).length;
    setDraftContent(nextDraft);
    setSession({
      ...session,
      annotations: reconcileAnnotationsAfterExternalReplacement(session.annotations, target.fromLine, target.toLine, insertedLineCount),
      chapterReviewRuns: session.chapterReviewRuns.map((run) => {
        if (run.id !== reviewRun.id) return { ...run, status: "stale" as const, verdict: "stale" as const };
        return {
          ...run,
          status: "stale" as const,
          verdict: "stale" as const,
          findings: reconcileFindingsAfterReplacement(run.findings, id, target.fromLine!, target.toLine!, insertedLineCount)
        };
      })
    });
    showNotice("建议已写入草稿；本次整章体检已过期，保存后请重新体检。");
  }

  function dismissChapterFinding(id: string) {
    if (!session) return;
    const run = session.chapterReviewRuns.find((item) => item.findings.some((finding) => finding.id === id));
    const target = run?.findings.find((item) => item.id === id);
    if (!run || !target) return;
    let reason = "用户判断当前无需修改";
    if (target.severity === "S1" || target.severity === "S2") {
      const input = window.prompt("S1/S2 会阻止审查通过。若这是误报，请填写标记“不适用”的理由：", "");
      if (!input?.trim()) {
        showNotice("未填写理由，S1/S2 仍保持待处理状态。");
        return;
      }
      reason = input.trim();
    }
    setSession({
      ...session,
      chapterReviewRuns: session.chapterReviewRuns.map((item) => {
        if (item.id !== run.id) return item;
        const findings = item.findings.map((finding) => finding.id === id ? { ...finding, status: "dismissed" as const, dismissalReason: reason } : finding);
        return { ...item, verdict: item.status === "stale" ? "stale" : computeChapterReviewVerdict(findings), findings };
      })
    });
  }

  async function callAi(id: string, mode: "new" | "retry" = "new") {
    const annotation = session?.annotations.find((item) => item.id === id);
    if (!annotation || !session) return;
    const currentOriginalText = getLineText(draftContent, annotation.fromLine, annotation.toLine);
    const currentAnchorHash = createTextAnchor(draftContent, annotation.fromLine, annotation.toLine);
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
    if (mode === "new") {
      const userMessage: ReviewConversationMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: question,
        createdAt: new Date().toISOString()
      };
      visibleMessages = [...existingMessages, userMessage];
    }

    updateAnnotation(id, {
      comment: "",
      messages: visibleMessages,
      originalText: currentOriginalText,
      anchorHash: currentAnchorHash,
      suggestion: undefined,
      status: "running",
      error: undefined
    });
    const requestKey = `${session.projectId}:${session.documentPath}`;
    const controller = new AbortController();
    aiRequestsRef.current.add(controller);
    try {
      await streamAiSuggestion(
        {
          projectId: session.projectId,
          documentPath: session.documentPath,
          content: draftContent,
          fromLine: annotation.fromLine,
          toLine: annotation.toLine,
          comment: question,
          engine: annotation.engine,
          annotationId: annotation.id,
          history: requestHistory
        },
        (event) => {
          if (controller.signal.aborted || activeDocumentKeyRef.current !== requestKey) return;
          if (event.type === "result") {
            const assistantMessage: ReviewConversationMessage = {
              id: crypto.randomUUID(),
              role: "assistant",
              content: event.reply,
              suggestion: event.suggestion,
              engine: event.engine,
              createdAt: new Date().toISOString()
            };
            updateAnnotation(id, {
              status: "ready",
              messages: [...visibleMessages, assistantMessage],
              suggestion: event.suggestion,
              anchorHash: event.anchorHash
            });
          }
          if (event.type === "error") updateAnnotation(id, { status: "error", error: event.message });
        },
        controller.signal
      );
    } catch (caught) {
      if (controller.signal.aborted) return;
      updateAnnotation(id, { status: "error", error: getError(caught) });
    } finally {
      aiRequestsRef.current.delete(controller);
    }
  }

  async function processAll() {
    const queue = session?.annotations.filter((item) =>
      ["draft", "pending", "error", "stale"].includes(item.status) &&
      (Boolean(item.comment.trim()) || (item.status === "error" && Boolean(item.messages?.some((message) => message.role === "user"))))
    ) ?? [];
    for (const annotation of queue) await callAi(annotation.id, annotation.status === "error" && !annotation.comment.trim() ? "retry" : "new");
  }

  function acceptSuggestion(id: string) {
    const annotation = session?.annotations.find((item) => item.id === id);
    if (!annotation?.suggestion || !session) return;
    const currentText = getLineText(draftContent, annotation.fromLine, annotation.toLine);
    if (currentText !== annotation.suggestion.before || !annotation.suggestion.after.trim() || annotation.suggestion.after.length > 10_000) {
      updateAnnotation(id, { status: "stale", error: "原文已经变化，需要重新分析后才能采用。" });
      return;
    }

    const nextDraft = replaceLineRange(draftContent, annotation.fromLine, annotation.toLine, annotation.suggestion.after);
    const insertedLines = annotation.suggestion.after.split(/\r?\n/).length;
    setDraftContent(nextDraft);
    setSession({
      ...session,
      annotations: reconcileAnnotationsAfterReplacement(
        session.annotations,
        id,
        annotation.fromLine,
        annotation.toLine,
        insertedLines
      ),
      chapterReviewRuns: session.chapterReviewRuns.map((run) => ({
        ...run,
        status: "stale" as const,
        verdict: "stale" as const,
        findings: reconcileFindingsAfterReplacement(run.findings, "", annotation.fromLine, annotation.toLine, insertedLines)
      }))
    });
    showNotice("建议已应用到当前草稿，点击“保存”后才会写入文件");
  }

  async function handleExport() {
    if (!session) return;
    try {
      const savedSession = await saveReviewSession(session);
      setSession(savedSession);
      const result = await exportReviewSession(session.projectId, session.documentPath);
      showNotice(`审校报告已导出：${result.path}`);
      setLibrary(await fetchLibrary(session.projectId));
    } catch (caught) {
      showNotice(getError(caught));
    }
  }

  async function refreshProjects(nextActive?: string) {
    const payload = await fetchProjects();
    setProjects(payload.projects);
    setActiveProjectId(nextActive ?? payload.activeProjectId ?? payload.projects[0]?.id ?? "");
  }

  async function handleCreateDocument(pathInput: string) {
    if (!activeProjectId) return;
    const path = normalizeDocumentPath(pathInput);
    if (!path) return;
    try {
      const created = await saveDocument(activeProjectId, path, `# ${path.split("/").at(-1)?.replace(/\.md$/i, "") ?? "未命名文档"}\n\n`);
      setNewDocumentOpen(false);
      setLibrary(await fetchLibrary(activeProjectId));
      navigateToPath(created.path);
      setMode("edit");
      showNotice("新文档已创建");
    } catch (caught) {
      showNotice(getError(caught));
    }
  }

  async function handleDeleteDocument() {
    if (!activeProjectId || !selectedPath) return;
    try {
      await deleteDocument(activeProjectId, selectedPath);
      setDeleteDocumentOpen(false);
      const nextLibrary = await fetchLibrary(activeProjectId);
      setLibrary(nextLibrary);
      const next = nextLibrary.featured.latestChapter ?? nextLibrary.featured.context ?? nextLibrary.groups.flatMap((group) => group.entries)[0];
      if (next) navigateToPath(next.path);
      else setSelectedPath("");
      showNotice("文档已移到回收站，可以恢复");
    } catch (caught) {
      showNotice(getError(caught));
    }
  }

  if (loading) return <LoadingScreen />;
  if (error && !projects.length) return <FailureScreen message={error} onRetry={() => { setError(""); void initialize(); }} />;

  return (
    <div className="workbench-shell">
      <header className="app-toolbar">
        <div className="window-controls" aria-hidden="true">
          <Circle className="control-close" />
          <Circle className="control-minimize" />
          <Circle className="control-expand" />
        </div>
        <div className="history-buttons">
          <button className="icon-button" aria-label="返回上一份文档" title="返回上一份文档" disabled={documentHistoryIndex <= 0} onClick={() => navigateDocumentHistory(-1)}><ArrowLeft size={17} /></button>
          <button className="icon-button" aria-label="前进到下一份文档" title="前进到下一份文档" disabled={documentHistoryIndex < 0 || documentHistoryIndex >= documentHistory.length - 1} onClick={() => navigateDocumentHistory(1)}><ArrowRight size={17} /></button>
        </div>
        <div className="project-switcher" title={`当前作品：${activeProject?.name ?? "未选择作品"}`}>
          <BookOpen size={16} />
          <strong>{activeProject?.name ?? "未选择作品"}</strong>
        </div>
        <button className="toolbar-button" onClick={() => setProjectManagerOpen(true)}><FolderCog size={16} />管理作品</button>
        <label className="global-search">
          <Search size={16} />
          <input
            ref={searchInputRef}
            value={query}
            aria-label="搜索当前小说资料"
            onChange={(event) => {
              setQuery(event.target.value);
              if (event.target.value.trim()) setLeftCollapsed(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                event.currentTarget.blur();
              }
            }}
            placeholder="输入关键词搜索当前小说资料"
          />
          <kbd>Ctrl K</kbd>
        </label>
        <button className="toolbar-button" onClick={() => setNewDocumentOpen(true)} disabled={!activeProjectId}><Plus size={17} />新建文档</button>
        <div className="mode-switch" aria-label="文档模式">
          {(["preview", "review", "edit"] as WorkspaceMode[]).map((item) => (
            <button key={item} className={mode === item ? "active" : ""} onClick={() => setMode(item)}>
              {item === "preview" ? "预览" : item === "review" ? "审校" : "编辑"}
            </button>
          ))}
        </div>
        {!rightVisible ? <button className="icon-button" onClick={() => setRightVisible(true)} title="显示审校栏"><PanelRightOpen size={17} /></button> : null}
        <button className="icon-button" onClick={() => setDark((value) => !value)} title="切换明暗模式">{dark ? <Sun size={17} /> : <Moon size={17} />}</button>
      </header>

      <main
        ref={workbenchRef}
        className={cn("workbench-grid", leftCollapsed && "left-collapsed", !rightVisible && "right-collapsed")}
        style={workbenchStyle}
      >
        <LibrarySidebar
          groups={library?.groups ?? []}
          selectedPath={selectedPath}
          query={query}
          searchResults={searchResults}
          searchStatus={searchStatus}
          searchError={searchError}
          collapsed={leftCollapsed}
          openGroups={openGroups}
          aiConnected={Boolean(aiStatus?.deepseek.available || aiStatus?.codex.available)}
          onToggleCollapsed={() => setLeftCollapsed((value) => !value)}
          onToggleGroup={(id) => setOpenGroups((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])}
          onSelect={selectEntry}
          onOpenAiSettings={() => setAiSettingsOpen(true)}
        />

        {!leftCollapsed ? (
          <PaneResizeHandle
            side="left"
            value={effectivePaneWidths.left}
            onChange={(width) => handlePaneWidthChange("left", width)}
            onReset={() => handlePaneWidthChange("left", DEFAULT_PANE_WIDTHS.left)}
          />
        ) : null}

        <section className="document-workspace">
          <div className="document-toolbar">
            <button className="mobile-menu" onClick={() => setLeftCollapsed(false)}><Menu size={17} /></button>
            <span className="document-kind">文档</span>
            <strong title={selectedPath}>{selectedEntry?.fileName ?? "尚未选择文档"}</strong>
            <ChevronDown size={14} />
            <div className="document-stats">
              <span>{dirty ? "未保存" : "已保存"}</span>
              <WordCount wordCount={wordCount} isChapter={selectedEntry?.groupId === "chapters"} />
              <span>Markdown</span>
            </div>
            {mode === "edit" ? (
              <button className="primary-button" onClick={handleSave} disabled={!dirty || saving}>
                {saving ? <LoaderCircle size={15} className="animate-spin" /> : <Save size={15} />}{saving ? "保存中" : "保存"}
              </button>
            ) : (
              <button className="soft-button" onClick={() => setMode("edit")}><PencilLine size={15} />编辑</button>
            )}
            <button className="icon-button danger" onClick={() => setDeleteDocumentOpen(true)} disabled={!selectedPath} title="移到回收站"><Trash2 size={16} /></button>
          </div>

          <div className="document-surface">
            {contentLoading ? (
              <div className="surface-state"><LoaderCircle className="animate-spin" />正在读取文档…</div>
            ) : !document ? (
              <div className="surface-state"><FilePlus2 />请选择或新建一个 Markdown 文档</div>
            ) : mode === "preview" ? (
              <Suspense fallback={<div className="surface-state"><LoaderCircle className="animate-spin" />正在载入预览…</div>}>
                <div className="markdown-preview"><MarkdownView content={draftContent} /></div>
              </Suspense>
            ) : (
              <Suspense fallback={<div className="surface-state"><LoaderCircle className="animate-spin" />正在载入编辑器…</div>}>
                <NovelEditor
                  value={draftContent}
                  mode={mode}
                  annotations={editorMarks}
                  selectedAnnotationId={selectedAnnotationId}
                  revealRequest={annotationRevealRequest}
                  onChange={handleDraftChange}
                  onLineClick={handleLineClick}
                  onRevealHandled={handleAnnotationRevealHandled}
                />
              </Suspense>
            )}
          </div>
        </section>

        {rightVisible ? (
          <PaneResizeHandle
            side="right"
            value={effectivePaneWidths.right}
            onChange={(width) => handlePaneWidthChange("right", width)}
            onReset={() => handlePaneWidthChange("right", DEFAULT_PANE_WIDTHS.right)}
          />
        ) : null}

        {rightVisible ? (
          <aside className="right-workbench">
            <nav className="right-tabs" aria-label="右侧工作台">
              <button className={rightTab === "review" ? "active" : ""} onClick={() => setRightTab("review")}>审校</button>
              <button className={rightTab === "workflow" ? "active" : ""} onClick={() => setRightTab("workflow")}>流程</button>
              <button className={rightTab === "recovery" ? "active" : ""} onClick={() => setRightTab("recovery")}>恢复</button>
              <button className="icon-button" onClick={() => setRightVisible(false)} title="关闭右栏"><X size={15} /></button>
            </nav>
            {rightTab === "review" ? <Suspense fallback={<div className="surface-state"><LoaderCircle className="animate-spin" />正在载入审校面板…</div>}><ReviewPanel
            annotations={session?.annotations ?? []}
            chapterReview={latestChapterReview}
            isChapter={selectedEntry?.groupId === "chapters"}
            reviewBusy={chapterReviewBusy}
            reviewMessage={chapterReviewMessage}
            selectedId={selectedAnnotationId}
            aiStatus={aiStatus}
            onSelect={selectAndRevealAnnotation}
            onClose={() => setRightVisible(false)}
            onOpenSettings={() => setAiSettingsOpen(true)}
            onUpdate={updateAnnotation}
            onCallAi={(id) => void callAi(id)}
            onAccept={acceptSuggestion}
            onIgnore={(id) => updateAnnotation(id, { status: "ignored" })}
            onRegenerate={(id) => {
              void callAi(id, "retry");
            }}
            onDelete={(id) => {
              setSession((current) => current ? { ...current, annotations: current.annotations.filter((item) => item.id !== id) } : current);
              setSelectedAnnotationId(undefined);
            }}
            onProcessAll={() => void processAll()}
            onRunChapterReview={(engine) => void runChapterReview(engine)}
            onAcceptFinding={acceptChapterFinding}
            onDismissFinding={dismissChapterFinding}
            onLocateFinding={(id) => {
              selectAndRevealAnnotation(id);
              setMode("review");
            }}
            onExport={() => void handleExport()}
            /></Suspense> : null}
            {rightTab === "workflow" ? (
              <WorkflowPanel
                status={workflowStatus}
                loading={workflowLoading}
                busy={workflowBusy}
                onRefresh={() => void refreshWorkflow()}
                onAction={handleWorkflowAction}
              />
            ) : null}
            {rightTab === "recovery" ? (
              <RecoveryPanel
                projectId={activeProjectId}
                document={document}
                onDocumentRestored={(restored) => {
                  setDocument(restored);
                  setDraftContent(restored.content);
                  setSession((current) => current ? {
                    ...current,
                    baseRevision: restored.revision,
                    chapterReviewRuns: current.chapterReviewRuns.map((run) => ({ ...run, status: "stale", verdict: "stale" }))
                  } : current);
                }}
                onLibraryChanged={async () => {
                  if (activeProjectId) setLibrary(await fetchLibrary(activeProjectId));
                }}
                onNotice={showNotice}
              />
            ) : null}
          </aside>
        ) : null}
      </main>

      {notice ? <div className="toast"><Check size={16} />{notice}</div> : null}
      {error ? <ErrorDialog message={error} onClose={() => setError("")} /> : null}
      {projectManagerOpen ? (
        <ProjectManager
          projects={projects}
          activeProjectId={activeProjectId}
          onClose={() => setProjectManagerOpen(false)}
          onSwitch={switchProject}
          onCreate={async (name) => {
            const result = await createProject(name);
            await refreshProjects(result.project?.id);
            showNotice("新小说已创建");
          }}
          onDelete={async (id) => {
            const result = await deleteProject(id);
            await refreshProjects(result.activeProjectId ?? undefined);
            showNotice("小说已移到回收站，可以恢复");
          }}
        />
      ) : null}
      {aiSettingsOpen && aiStatus ? (
        <AiSettingsDialog
          status={aiStatus}
          onClose={() => setAiSettingsOpen(false)}
          onSave={async (settings) => {
            const next = await updateAiSettings(settings);
            setAiStatus(next);
            setAiSettingsOpen(false);
            showNotice("AI 设置已保存");
          }}
        />
      ) : null}
      {newDocumentOpen ? <NewDocumentDialog onClose={() => setNewDocumentOpen(false)} onCreate={handleCreateDocument} /> : null}
      {deleteDocumentOpen ? (
        <ConfirmDialog
          title="把文档移到回收站？"
          description={`“${selectedEntry?.title ?? selectedPath}”不会永久删除，可以从 .trash 中恢复。`}
          confirmLabel="移到回收站"
          danger
          onClose={() => setDeleteDocumentOpen(false)}
          onConfirm={handleDeleteDocument}
        />
      ) : null}
    </div>
  );
}

function PaneResizeHandle({ side, value, onChange, onReset }: {
  side: PaneSide;
  value: number;
  onChange: (width: number) => void;
  onReset: () => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number }>();

  useEffect(() => () => {
    document.documentElement.classList.remove("is-pane-resizing");
  }, []);

  function finishResize(element: HTMLDivElement, pointerId: number) {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    dragRef.current = undefined;
    document.documentElement.classList.remove("is-pane-resizing");
  }

  return (
    <div
      className={cn("pane-resize-handle", `${side}-resize-handle`)}
      data-pane-resizer={side}
      role="separator"
      aria-label={side === "left" ? "调整资料库宽度" : "调整 AI 审阅栏宽度"}
      aria-orientation="vertical"
      aria-valuemin={PANE_WIDTH_LIMITS[side].min}
      aria-valuemax={PANE_WIDTH_LIMITS[side].max}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)} 像素`}
      tabIndex={0}
      title="拖动调整宽度；方向键微调；双击恢复默认"
      onDoubleClick={onReset}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: value
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.documentElement.classList.add("is-pane-resizing");
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const boundaryMovement = event.clientX - drag.startX;
        onChange(drag.startWidth + (side === "left" ? boundaryMovement : -boundaryMovement));
      }}
      onPointerUp={(event) => finishResize(event.currentTarget, event.pointerId)}
      onPointerCancel={(event) => finishResize(event.currentTarget, event.pointerId)}
      onKeyDown={(event) => {
        if (event.key === "Home") {
          event.preventDefault();
          onReset();
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const boundaryMovement = event.key === "ArrowRight" ? 16 : -16;
        onChange(value + (side === "left" ? boundaryMovement : -boundaryMovement));
      }}
    />
  );
}

function WordCount({ wordCount, isChapter }: { wordCount: number; isChapter: boolean }) {
  const status = getChapterWordCountStatus(wordCount);
  const detail = !isChapter ? "实时字数" : status === "valid" ? "已达标" : status === "short" ? `还差 ${CHAPTER_WORD_COUNT_MIN - wordCount} 字` : `超出 ${wordCount - CHAPTER_WORD_COUNT_MAX} 字`;
  return (
    <span className={cn("word-count", isChapter && `is-${status}`)} title={isChapter ? `章节目标 ${CHAPTER_WORD_COUNT_MIN}-${CHAPTER_WORD_COUNT_MAX} 字，${detail}` : detail}>
      {formatWordCount(wordCount)}
      {isChapter ? <small>{detail}</small> : null}
    </span>
  );
}

function ProjectManager({ projects, activeProjectId, onClose, onSwitch, onCreate, onDelete }: {
  projects: ProjectSummary[];
  activeProjectId: string;
  onClose: () => void;
  onSwitch: (id: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="管理作品" subtitle="删除会移到回收站，不会永久清除" onClose={onClose}>
      <div className="project-list">
        {projects.map((project) => (
          <div key={project.id} className={cn("project-row", project.id === activeProjectId && "active")}>
            <BookOpen size={17} />
            <span><strong>{project.name}</strong><small>{project.id === activeProjectId ? "当前作品" : "独立资料库"}</small></span>
            {project.id !== activeProjectId ? <button className="soft-button" onClick={() => void onSwitch(project.id)}>切换</button> : null}
            <button className="icon-button danger" onClick={() => setPendingDelete(project.id)} title="移到回收站"><Trash2 size={15} /></button>
          </div>
        ))}
      </div>
      <form className="modal-form-row" onSubmit={async (event) => { event.preventDefault(); if (!name.trim()) return; setBusy(true); try { await onCreate(name.trim()); setName(""); } finally { setBusy(false); } }}>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="输入新小说名称" />
        <button className="primary-button" disabled={busy || !name.trim()}><Plus size={15} />新建小说</button>
      </form>
      {pendingDelete ? (
        <div className="inline-confirm">
          <strong>确认移到回收站？</strong>
          <p>作品目录会被移动到 `.trash/projects/`，之后仍可恢复。</p>
          <button className="soft-button" onClick={() => setPendingDelete(undefined)}>取消</button>
          <button className="danger-button" onClick={async () => { setBusy(true); try { await onDelete(pendingDelete); setPendingDelete(undefined); } finally { setBusy(false); } }} disabled={busy}><Trash2 size={15} />确认移动</button>
        </div>
      ) : null}
    </Modal>
  );
}

function AiSettingsDialog({ status, onClose, onSave }: { status: AiStatus; onClose: () => void; onSave: (settings: AiSettingsUpdate) => Promise<void> }) {
  const [settings, setSettings] = useState(status.settings);
  const [deepseekApiKey, setDeepseekApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="AI 设置" subtitle="默认复用 Codex 登录；DeepSeek 仅作为手动回退，密钥不会回显" onClose={onClose}>
      <div className="provider-grid">
        <ProviderStatus name="Codex · 深度审校" available={status.codex.available} detail={status.codex.error ?? status.codex.model} selected={settings.engine === "codex"} onSelect={() => setSettings({ ...settings, engine: "codex" })} />
        <ProviderStatus name="DeepSeek V4-Flash · 手动回退" available={status.deepseek.available} detail={status.deepseek.error ?? status.deepseek.model} selected={settings.engine === "deepseek"} onSelect={() => setSettings({ ...settings, engine: "deepseek" })} />
      </div>
      <label className="field"><span>DeepSeek API 密钥（回退）</span><span className="secret-input"><input type={showApiKey ? "text" : "password"} value={deepseekApiKey} onChange={(event) => setDeepseekApiKey(event.target.value)} placeholder={status.deepseek.configured ? "已保存；留空表示不修改" : "粘贴以 sk- 开头的密钥"} autoComplete="new-password" /><button type="button" className="secret-toggle" onClick={() => setShowApiKey((current) => !current)} aria-label={showApiKey ? "隐藏密钥" : "显示密钥"} title={showApiKey ? "隐藏密钥" : "显示密钥"}>{showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></span><small>只有手动切换到 DeepSeek 时才使用；接口只返回“已配置”，不会返回密钥内容。</small></label>
      <label className="field"><span>DeepSeek 回退模型</span><input value="deepseek-v4-flash" readOnly /><small>DeepSeek 回退请求固定使用 V4-Flash。</small></label>
      <label className="field"><span>Codex 推理强度</span><select value={settings.reasoningEffort} onChange={(event) => setSettings({ ...settings, reasoningEffort: event.target.value as AiSettings["reasoningEffort"] })}><option value="low">低 · 更快</option><option value="medium">中 · 推荐</option><option value="high">高 · 更细致</option></select></label>
      <label className="check-field"><input type="checkbox" checked={settings.includeStyleGuide} onChange={(event) => setSettings({ ...settings, includeStyleGuide: event.target.checked })} /><span>读取当前小说的文风指南</span></label>
      <label className="check-field"><input type="checkbox" checked={settings.includeWritingTaskbook} onChange={(event) => setSettings({ ...settings, includeWritingTaskbook: event.target.checked })} /><span>划线精修时读取当前章节的本章写作任务书</span></label>
      <div className="setup-note"><Settings2 size={16} /><p>Codex 不需要单独填写 API 密钥：工作台会复用本机 Codex App / CLI 的 ChatGPT 登录状态。上方两张卡片可以直接点击，选择默认审校引擎。</p></div>
      <div className="modal-actions"><button className="soft-button" onClick={onClose}>取消</button><button className="primary-button" onClick={async () => { setBusy(true); try { await onSave({ ...settings, ...(deepseekApiKey.trim() ? { deepseekApiKey: deepseekApiKey.trim() } : {}) }); } finally { setBusy(false); } }} disabled={busy}>{busy && <LoaderCircle size={15} className="animate-spin" />}保存设置</button></div>
    </Modal>
  );
}

function ProviderStatus({ name, available, detail, selected, onSelect }: { name: string; available: boolean; detail: string; selected: boolean; onSelect: () => void }) {
  return <button type="button" className={cn("provider-status", available && "online", selected && "selected")} onClick={onSelect} aria-pressed={selected}><span className={cn("status-dot", available && "online")} /><strong>{name}</strong><span className="provider-radio">{selected ? <Check size={12} /> : null}</span><small>{detail}</small></button>;
}

function NewDocumentDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (path: string) => Promise<void> }) {
  const [path, setPath] = useState("正文/第001章_新章节.md");
  return <Modal title="新建 Markdown 文档" subtitle="路径只能位于当前小说目录内" onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); void onCreate(path); }}><label className="field"><span>文档路径</span><input autoFocus value={path} onChange={(event) => setPath(event.target.value)} /></label><div className="modal-actions"><button type="button" className="soft-button" onClick={onClose}>取消</button><button className="primary-button"><FilePlus2 size={15} />创建文档</button></div></form></Modal>;
}

function ConfirmDialog({ title, description, confirmLabel, danger, onClose, onConfirm }: { title: string; description: string; confirmLabel: string; danger?: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return <Modal title={title} subtitle={description} onClose={onClose}><div className="modal-actions"><button className="soft-button" onClick={onClose}>取消</button><button className={danger ? "danger-button" : "primary-button"} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}>{busy && <LoaderCircle size={15} className="animate-spin" />}{confirmLabel}</button></div></Modal>;
}

function ErrorDialog({ message, onClose }: { message: string; onClose: () => void }) {
  return <Modal title="操作没有完成" subtitle={message} onClose={onClose}><div className="modal-actions"><button className="primary-button" onClick={onClose}>我知道了</button></div></Modal>;
}

function Modal({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header><div><h2 id="modal-title">{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose}><X size={17} /></button></header><div className="modal-body">{children}</div></section></div>;
}

function LoadingScreen() {
  return <div className="full-state"><LoaderCircle className="animate-spin" /><strong>正在打开小说工作台</strong></div>;
}

function FailureScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="full-state"><CircleError /><strong>无法读取作品库</strong><p>{message}</p><button className="primary-button" onClick={onRetry}>重新尝试</button></div>;
}

function CircleError() { return <span className="failure-mark"><X size={20} /></span>; }

function migrateReviewAnnotation(annotation: ReviewAnnotation): ReviewAnnotation {
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
    messages.push({
      id: `${annotation.id}-legacy-user`,
      role: "user",
      content: annotation.comment.trim(),
      createdAt: annotation.createdAt
    });
  }
  messages.push({
    id: `${annotation.id}-legacy-assistant`,
    role: "assistant",
    content: annotation.suggestion.decision === "keep"
      ? "这段原文可以保留。"
      : "我根据你的要求给出了一版可直接替换的文本。",
    suggestion: annotation.suggestion,
    engine: annotation.engine,
    createdAt
  });
  return { ...annotation, comment: "", messages };
}

function normalizeDocumentPath(value: string) {
  const path = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  return path && !path.toLowerCase().endsWith(".md") ? `${path}.md` : path;
}

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n/g, "\n");
}

function getError(caught: unknown) {
  return caught instanceof Error ? caught.message : "发生未知错误";
}
