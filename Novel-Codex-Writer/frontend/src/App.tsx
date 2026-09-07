import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  WorkbenchView,
  type WorkbenchViewActions,
  type WorkbenchViewModel
} from "./components/WorkbenchView";
import {
  createProject,
  confirmProjectImport,
  deleteDocument,
  deleteProject,
  fetchAiStatus,
  fetchLibrary,
  fetchSystemPreflight,
  fetchProjects,
  previewProjectImport,
  saveDocument,
  saveDocumentRevision,
  updateAiSettings,
  updateProject
} from "./lib/api";
import {
  countReadableWords,
} from "./lib/format";
import {
  COMPACT_LAYOUT_MAX_WIDTH,
  clampPaneWidth,
  fitPaneWidths,
  readStoredPaneWidth,
  type PaneSide,
  type PaneWidths
} from "./lib/pane-layout";
import { invalidateReviewSessionForRestoredDocument } from "./lib/review";
import { useLibrarySearch } from "./hooks/useLibrarySearch";
import { useReviewController } from "./hooks/useReviewController";
import { useReviewPersistence } from "./hooks/useReviewPersistence";
import { createContentLoadingTracker, useDocumentLifecycle, useProjectLibraryLifecycle } from "./hooks/useProjectDocumentLifecycle";
import { useWorkflowController } from "./hooks/useWorkflowController";
import type {
  AiSettingsUpdate,
  AiStatus,
  DocumentEntry,
  DocumentResponse,
  GroupId,
  LibraryResponse,
  ProjectSummary,
  ProjectImportPreview,
  ReviewSession,
  SystemPreflight,
  WorkspaceMode
} from "./types";

import { useTheme } from "./hooks/useTheme";
import { readPreference, writePreference, removePreference, recentDocumentKey } from "./lib/preferences";

const initialOpenGroups: GroupId[] = ["chapters", "outlines"];
const validGroupIds = new Set<GroupId>([
  "chapters", "current", "indexes", "archives", "outlines", "guides",
  "reviews", "commits", "memoryPatches", "snapshots"
]);
const LEFT_PANE_STORAGE_KEY = "novel-left-pane-width";
const REVIEW_PANE_STORAGE_KEY = "novel-review-pane-width";

function readOpenGroups() {
  const storedValue = readPreference("novel-open-groups");
  if (storedValue === null) return initialOpenGroups;
  try {
    const stored: unknown = JSON.parse(storedValue);
    if (Array.isArray(stored) && stored.every(
      (value): value is GroupId => typeof value === "string" && validGroupIds.has(value as GroupId)
    )) {
      return [...new Set(stored)];
    }
  } catch {
    // Invalid persisted UI state is removed below so the next startup is deterministic.
  }
  removePreference("novel-open-groups");
  return initialOpenGroups;
}

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState("");
  const [library, setLibrary] = useState<LibraryResponse>();
  const [selectedPath, setSelectedPath] = useState("");
  const [document, setDocument] = useState<DocumentResponse>();
  const [draftContent, setDraftContent] = useState("");
  const [mode, setMode] = useState<WorkspaceMode>("review");
  const [session, setSession] = useState<ReviewSession>();
  const [aiStatus, setAiStatus] = useState<AiStatus>();
  const [query, setQuery] = useState("");
  const [leftCollapsed, setLeftCollapsed] = useState(() => window.innerWidth < 1200 || readPreference("novel-left-collapsed") === "true");
  const [rightVisible, setRightVisible] = useState(() => window.innerWidth >= 1024);
  const [rightTab, setRightTab] = useState<"review" | "workflow" | "memory">("workflow");
  const [documentHistory, setDocumentHistory] = useState<string[]>([]);
  const [documentHistoryIndex, setDocumentHistoryIndex] = useState(-1);
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(() => ({
    left: readStoredPaneWidth(readPreference(LEFT_PANE_STORAGE_KEY), "left"),
    right: readStoredPaneWidth(readPreference(REVIEW_PANE_STORAGE_KEY), "right")
  }));
  const [workbenchWidth, setWorkbenchWidth] = useState(0);
  const [openGroups, setOpenGroups] = useState<GroupId[]>(readOpenGroups);
  const { dark, themePreference, setThemePreference } = useTheme();
  const [focusMode, setFocusMode] = useState(false);
  const focusSnapshot = useRef({ leftCollapsed: false, rightVisible: true });
  function toggleFocus() {
    if (focusMode) {
      setLeftCollapsed(window.innerWidth < 1200 || focusSnapshot.current.leftCollapsed);
      setRightVisible(window.innerWidth >= 1024 && focusSnapshot.current.rightVisible);
    } else {
      focusSnapshot.current = { leftCollapsed, rightVisible };
      setLeftCollapsed(true);
      setRightVisible(false);
    }
    setFocusMode((value) => !value);
  }
  function openLeftPane() {
    setFocusMode(false);
    setLeftCollapsed(false);
    if (window.innerWidth < 1024) setRightVisible(false);
  }
  function openRightPane() {
    setFocusMode(false);
    setRightVisible(true);
    if (window.innerWidth < 1200) setLeftCollapsed(true);
  }
  const [loading, setLoading] = useState(true);
  const [contentLoading, setContentLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [preflight, setPreflight] = useState<SystemPreflight>();
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [deleteDocumentOpen, setDeleteDocumentOpen] = useState(false);
  const sessionLoadedRef = useRef(false);
  const noticeTimerRef = useRef<number>();
  const saveRequestIdRef = useRef(0);
  const projectSwitchIdRef = useRef(0);
  const projectSwitchBusyRef = useRef(false);
  const projectSwitchControllerRef = useRef<AbortController>();
  const projectsRefreshIdRef = useRef(0);
  const initializeIdRef = useRef(0);
  const initializeControllerRef = useRef<AbortController>();
  const activeProjectIdRef = useRef("");
  const selectionKeyRef = useRef("");
  const documentHistoryRef = useRef({ items: [] as string[], index: -1 });
  const workbenchRef = useRef<HTMLElement>(null);
  const beginContentLoadingRef = useRef<ReturnType<typeof createContentLoadingTracker>>();
  beginContentLoadingRef.current ??= createContentLoadingTracker(setContentLoading);
  const reviewPersistence = useReviewPersistence(session, setSession, sessionLoadedRef, setNotice);
  const beginContentLoading = beginContentLoadingRef.current;

  const showNotice = useCallback((message: string) => {
    if (noticeTimerRef.current !== undefined) window.clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = undefined;
      setNotice("");
    }, 3200);
  }, []);

  const activeProject = projects.find((project) => project.id === activeProjectId);
  const selectedEntry = library?.groups.flatMap((group) => group.entries).find((entry) => entry.path === selectedPath);
  const wordCount = useMemo(() => countReadableWords(draftContent), [draftContent]);
  const dirty = Boolean(document && normalizeLineEndings(draftContent) !== normalizeLineEndings(document.content));
  activeProjectIdRef.current = activeProjectId;
  selectionKeyRef.current = `${activeProjectId}:${selectedPath}`;
  const {
    inputRef: searchInputRef,
    results: searchResults,
    status: searchStatus,
    error: searchError,
    retry: retrySearch
  } = useLibrarySearch({ activeProjectId, query });
  const {
    status: workflowStatus,
    setStatus: setWorkflowStatus,
    loading: workflowLoading,
    busy: workflowBusy,
    refresh: refreshWorkflow,
    runAction: handleWorkflowAction
  } = useWorkflowController({
    activeProjectId,
    chapterNumber: selectedEntry?.chapterNumber,
    libraryGeneratedAt: library?.generatedAt,
    libraryReady: Boolean(library),
    setLibrary,
    onNotice: showNotice,
    onOpenPath: openWorkflowArtifact
  });
  documentHistoryRef.current = { items: documentHistory, index: documentHistoryIndex };
  const {
    selectedAnnotationId,
    setSelectedAnnotationId,
    annotationRevealRequest,
    chapterReviewBusy,
    batchReviewBusy,
    chapterReviewMessage,
    handleLineClick,
    handleAnnotationRevealHandled,
    selectAndRevealAnnotation,
    updateAnnotation,
    invalidateDraftBoundRequests,
    handleDraftChange,
    runChapterReview,
    acceptChapterFinding,
    dismissChapterFinding,
    callAi,
    processAll,
    acceptSuggestion,
    exportReview: handleExport,
    deleteAnnotation: deleteReviewAnnotation,
    locateFinding: locateReviewFinding
  } = useReviewController({
    activeProjectId,
    selectedPath,
    selectedEntry,
    session,
    setSession,
    document,
    draftContent,
    setDraftContent,
    dirty,
    aiStatus,
    setRightVisible,
    setMode,
    setLibrary,
    persistReviewSession: reviewPersistence.flush,
    getCurrentSession: reviewPersistence.getCurrent,
    onNotice: showNotice
  });
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

  useProjectLibraryLifecycle({
    activeProjectId,
    selectedPath,
    setLibrary,
    setWorkflowStatus,
    beginContentLoading,
    setSelectedPath,
    setOpenGroups,
    setError,
    navigateToPath
  });
  useDocumentLifecycle({
    activeProjectId,
    selectedPath,
    sessionLoadedRef,
    setDocument,
    setDraftContent,
    setSession,
    setSelectedAnnotationId,
    beginContentLoading,
    setError
  });

  useEffect(() => {
    const compact = window.matchMedia("(max-width: 1199px)");
    const mobile = window.matchMedia("(max-width: 1023px)");
    const update = () => {
      if (compact.matches) setLeftCollapsed(true);
      if (mobile.matches) setRightVisible(false);
    };
    compact.addEventListener("change", update);
    mobile.addEventListener("change", update);
    return () => {
      compact.removeEventListener("change", update);
      mobile.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    if (rightVisible && window.innerWidth < 1024) setLeftCollapsed(true);
  }, [rightVisible]);

  useEffect(() => {
    if (document && activeProjectId && document.path === selectedPath) {
      writePreference(recentDocumentKey(activeProjectId), selectedPath);
    }
  }, [document, activeProjectId, selectedPath]);

  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (dirty) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);

  useEffect(() => {
    writePreference("novel-left-collapsed", String(leftCollapsed));
    writePreference("novel-open-groups", JSON.stringify(openGroups));
  }, [leftCollapsed, openGroups]);

  useEffect(() => {
    writePreference(LEFT_PANE_STORAGE_KEY, String(paneWidths.left));
    writePreference(REVIEW_PANE_STORAGE_KEY, String(paneWidths.right));
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
    const requestId = ++initializeIdRef.current;
    initializeControllerRef.current?.abort();
    const controller = new AbortController();
    initializeControllerRef.current = controller;
    setLoading(true);
    void fetchAiStatus(controller.signal)
      .then((status) => {
        if (initializeIdRef.current === requestId && !controller.signal.aborted) setAiStatus(status);
      })
      .catch((caught) => {
        if (initializeIdRef.current === requestId && !controller.signal.aborted) {
          setNotice(`AI 暂不可用，普通编辑不受影响：${getError(caught)}`);
        }
      });
    void fetchSystemPreflight(controller.signal)
      .then((result) => {
        if (initializeIdRef.current !== requestId || controller.signal.aborted) return;
        setPreflight(result);
        if (!result.ready) setPreflightOpen(true);
      })
      .catch((caught) => {
        if (initializeIdRef.current === requestId && !controller.signal.aborted) {
          setNotice(`启动预检暂不可用：${getError(caught)}`);
        }
      });
    try {
      const projectPayload = await fetchProjects(controller.signal);
      if (initializeIdRef.current !== requestId || controller.signal.aborted) return;
      setProjects(projectPayload.projects);
      const active = projectPayload.projects.find((project) => project.id === projectPayload.activeProjectId);
      setActiveProjectId(active?.id ?? "");
      if (!active && projectPayload.projects.length) setProjectManagerOpen(true);
    } catch (caught) {
      if (initializeIdRef.current === requestId && !controller.signal.aborted) setError(getError(caught));
    } finally {
      if (initializeIdRef.current === requestId && !controller.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => () => {
    if (noticeTimerRef.current !== undefined) window.clearTimeout(noticeTimerRef.current);
    initializeControllerRef.current?.abort();
    projectSwitchControllerRef.current?.abort();
  }, []);

  function invalidatePendingSave() {
    saveRequestIdRef.current += 1;
    setSaving(false);
  }

  function requireSavedDraft(action: string) {
    if (dirty || saving) throw new Error(`请先保存当前草稿，再${action}`);
  }

  function navigateToPath(path: string, record = true) {
    invalidatePendingSave();
    if (activeProjectId && path) writePreference(recentDocumentKey(activeProjectId), path);
    if (record) {
      const current = documentHistoryRef.current;
      const retained = current.items.slice(0, current.index + 1);
      if (retained.at(-1) !== path) {
        const next = [...retained, path].slice(-50);
        documentHistoryRef.current = { items: next, index: next.length - 1 };
        setDocumentHistory(next);
        setDocumentHistoryIndex(next.length - 1);
      }
    }
    setSelectedPath(path);
  }

  function openWorkflowArtifact(path: string) {
    if (path === selectedPath) return;
    if (dirty) {
      showNotice(`动作已完成；当前草稿未保存，暂未自动打开 ${path}`);
      return;
    }
    navigateToPath(path);
    setMode("preview");
  }

  function openMemorySource(path: string, line: number) {
    if (path !== selectedPath && dirty) {
      showNotice("当前草稿未保存，已保留现场；保存后再打开记忆来源。");
      return;
    }
    navigateToPath(path);
    setMode("preview");
    showNotice(`已打开来源文档，请查看第 ${line} 行附近`);
  }

  function navigateDocumentHistory(direction: -1 | 1) {
    const current = documentHistoryRef.current;
    const nextIndex = current.index + direction;
    const nextPath = current.items[nextIndex];
    if (!nextPath || (dirty && !window.confirm("当前草稿还没有保存。确定离开吗？"))) return;
    documentHistoryRef.current = { items: current.items, index: nextIndex };
    setDocumentHistoryIndex(nextIndex);
    navigateToPath(nextPath, false);
    const entry = library?.groups.flatMap((group) => group.entries).find((item) => item.path === nextPath);
    setMode(entry?.groupId === "chapters" ? "review" : "preview");
  }

  function selectEntry(entry: DocumentEntry) {
    if (entry.path === selectedPath) return;
    if (dirty && !window.confirm("当前草稿还没有保存。确定切换文档吗？")) return;
    navigateToPath(entry.path);
    setQuery("");
    if (window.innerWidth < 1200) setLeftCollapsed(true);
    setMode(entry.groupId === "chapters" ? "review" : "preview");
  }

  async function switchProject(projectId: string) {
    if (projectId === activeProjectId) return;
    if (dirty && !window.confirm("当前草稿还没有保存。确定切换小说吗？")) return;
    if (projectSwitchBusyRef.current) return;
    projectSwitchBusyRef.current = true;
    projectSwitchControllerRef.current?.abort();
    const controller = new AbortController();
    projectSwitchControllerRef.current = controller;
    const requestId = ++projectSwitchIdRef.current;
    try {
      await updateProject(projectId, { active: true }, controller.signal);
      if (requestId !== projectSwitchIdRef.current) return;
      invalidatePendingSave();
      setLibrary(undefined);
      setActiveProjectId(projectId);
      setSelectedPath("");
      setDocumentHistory([]);
      setDocumentHistoryIndex(-1);
      documentHistoryRef.current = { items: [], index: -1 };
      setRightTab("workflow");
    } catch (caught) {
      if (controller.signal.aborted) return;
      if (requestId === projectSwitchIdRef.current) showNotice(getError(caught));
    } finally {
      if (projectSwitchControllerRef.current === controller) projectSwitchControllerRef.current = undefined;
      projectSwitchBusyRef.current = false;
    }
  }

  async function handleSave() {
    if (!document || !activeProjectId) return;
    const requestId = ++saveRequestIdRef.current;
    const projectId = activeProjectId;
    const selectionKey = selectionKeyRef.current;
    try {
      setSaving(true);
      const saved = await saveDocumentRevision(projectId, document.path, draftContent, document.revision);
      if (requestId !== saveRequestIdRef.current || selectionKey !== selectionKeyRef.current) return;
      setDocument(saved);
      setSession((current) => (current ? { ...current, baseRevision: saved.revision } : current));
      const nextLibrary = await fetchLibrary(projectId);
      if (requestId !== saveRequestIdRef.current || selectionKey !== selectionKeyRef.current) return;
      if (projectId === activeProjectIdRef.current) setLibrary(nextLibrary);
      showNotice("正文已保存，批注锚点已同步");
    } catch (caught) {
      if (requestId === saveRequestIdRef.current && selectionKey === selectionKeyRef.current) setError(getError(caught));
    } finally {
      if (requestId === saveRequestIdRef.current) setSaving(false);
    }
  }

  async function refreshProjects(nextActive?: string) {
    const requestId = ++projectsRefreshIdRef.current;
    const payload = await fetchProjects();
    if (requestId !== projectsRefreshIdRef.current) return;
    setProjects(payload.projects);
    const resolvedActive = nextActive ?? payload.activeProjectId ?? payload.projects[0]?.id ?? "";
    if (resolvedActive !== activeProjectIdRef.current) {
      invalidatePendingSave();
      setLibrary(undefined);
      setSelectedPath("");
      setDocumentHistory([]);
      setDocumentHistoryIndex(-1);
      documentHistoryRef.current = { items: [], index: -1 };
      setRightTab("workflow");
    }
    setActiveProjectId(resolvedActive);
  }

  async function handleCreateDocument(pathInput: string) {
    if (!activeProjectId) return;
    const projectId = activeProjectId;
    const path = normalizeDocumentPath(pathInput);
    if (!path) return;
    try {
      requireSavedDraft("新建文档");
      const created = await saveDocument(projectId, path, `# ${path.split("/").at(-1)?.replace(/\.md$/i, "") ?? "未命名文档"}\n\n`);
      if (projectId !== activeProjectIdRef.current) return;
      setNewDocumentOpen(false);
      const nextLibrary = await fetchLibrary(projectId);
      if (projectId !== activeProjectIdRef.current) return;
      setLibrary(nextLibrary);
      navigateToPath(created.path);
      setMode("edit");
      showNotice("新文档已创建");
    } catch (caught) {
      if (projectId === activeProjectIdRef.current) showNotice(getError(caught));
    }
  }

  async function handleDeleteDocument() {
    if (!activeProjectId || !selectedPath) return;
    const projectId = activeProjectId;
    const path = selectedPath;
    const selectionKey = selectionKeyRef.current;
    try {
      requireSavedDraft("移到回收站");
      await deleteDocument(projectId, path);
      if (selectionKey !== selectionKeyRef.current) return;
      setDeleteDocumentOpen(false);
      const nextLibrary = await fetchLibrary(projectId);
      if (selectionKey !== selectionKeyRef.current) return;
      setLibrary(nextLibrary);
      const next = nextLibrary.featured.latestChapter ?? nextLibrary.featured.context ?? nextLibrary.groups.flatMap((group) => group.entries)[0];
      if (next) navigateToPath(next.path);
      else setSelectedPath("");
      showNotice("文档已移到回收站，可以恢复");
    } catch (caught) {
      if (selectionKey === selectionKeyRef.current) showNotice(getError(caught));
    }
  }

  function handleDocumentRestored(restored: DocumentResponse) {
    invalidateDraftBoundRequests();
    setDocument(restored);
    setDraftContent(restored.content);
    setSession((current) => current
      ? invalidateReviewSessionForRestoredDocument(current, restored.revision)
      : current);
  }

  async function handleRecoveryLibraryChanged() {
    const projectId = activeProjectId;
    if (!projectId) return;
    const nextLibrary = await fetchLibrary(projectId);
    if (projectId === activeProjectIdRef.current) setLibrary(nextLibrary);
  }

  async function handleCreateProject(name: string) {
    requireSavedDraft("新建作品");
    const result = await createProject(name);
    await refreshProjects(result.project?.id);
    showNotice("新小说已创建");
  }

  async function handleImportPreview(file: File): Promise<ProjectImportPreview> {
    return previewProjectImport(file);
  }

  async function handleImportConfirm(token: string, name?: string) {
    requireSavedDraft("导入作品");
    const result = await confirmProjectImport(token, name);
    await refreshProjects(result.project?.id);
    setRightTab("workflow");
    showNotice("备份已作为新小说导入，原有作品没有被覆盖");
  }

  async function refreshPreflight() {
    try {
      setPreflight(await fetchSystemPreflight());
    } catch (caught) {
      showNotice(getError(caught));
    }
  }

  async function handleDeleteProject(id: string) {
    if (id === activeProjectId) requireSavedDraft("删除当前作品");
    const result = await deleteProject(id);
    await refreshProjects(result.activeProjectId ?? undefined);
    showNotice("小说已移到回收站，可以恢复");
  }

  async function handleSaveAiSettings(settings: AiSettingsUpdate) {
    const next = await updateAiSettings(settings);
    setAiStatus(next);
    setAiSettingsOpen(false);
    showNotice("AI 设置已保存");
  }

  const viewModel: WorkbenchViewModel = {
    loading,
    error,
    notice,
    projects,
    activeProjectId,
    activeProject,
    library,
    documentHistoryLength: documentHistory.length,
    documentHistoryIndex,
    query,
    searchResults,
    searchStatus,
    searchError,
    leftCollapsed,
    rightVisible,
    rightTab,
    dark,
    themePreference,
    focusMode,
    openGroups,
    paneWidths: effectivePaneWidths,
    workbenchStyle,
    selectedPath,
    selectedEntry,
    document,
    draftContent,
    mode,
    dirty,
    wordCount,
    saving,
    contentLoading,
    editorMarks,
    selectedAnnotationId,
    annotationRevealRequest,
    session,
    latestChapterReview,
    chapterReviewBusy,
    batchReviewBusy,
    chapterReviewMessage,
    aiStatus,
    workflowStatus,
    workflowLoading,
    workflowBusy,
    preflight,
    preflightOpen,
    projectManagerOpen,
    aiSettingsOpen,
    newDocumentOpen,
    deleteDocumentOpen
  };

  const viewActions: WorkbenchViewActions = {
    retry: () => {
      setError("");
      void initialize();
    },
    navigateHistory: navigateDocumentHistory,
    openProjectManager: () => setProjectManagerOpen(true),
    openPreflight: () => setPreflightOpen(true),
    setQuery,
    retrySearch,
    openLeftPane,
    toggleLeftPane: () => leftCollapsed ? openLeftPane() : setLeftCollapsed(true),
    openNewDocument: () => {
      if (dirty || saving) { showNotice("请先保存当前草稿，再新建文档"); return; }
      setNewDocumentOpen(true);
    },
    setMode,
    openRightPane,
    closeRightPane: () => setRightVisible(false),
    setRightTab,
    setThemePreference,
    toggleFocus,
    toggleGroup: (id) => setOpenGroups((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]),
    selectEntry,
    openAiSettings: () => setAiSettingsOpen(true),
    changePaneWidth: handlePaneWidthChange,
    save: () => void handleSave(),
    openDeleteDocument: () => {
      if (dirty || saving) { showNotice("请先保存当前草稿，再移到回收站"); return; }
      setDeleteDocumentOpen(true);
    },
    changeDraft: handleDraftChange,
    clickLine: (line, shift) => { handleLineClick(line, shift); openRightPane(); setRightTab("review"); },
    annotationRevealHandled: handleAnnotationRevealHandled,
    selectAnnotation: selectAndRevealAnnotation,
    updateAnnotation,
    callAi: (id, requestMode) => void callAi(id, requestMode),
    acceptSuggestion,
    deleteAnnotation: deleteReviewAnnotation,
    processAll: () => void processAll(),
    runChapterReview: (engine) => void runChapterReview(engine),
    acceptFinding: acceptChapterFinding,
    dismissFinding: dismissChapterFinding,
    locateFinding: locateReviewFinding,
    exportReview: handleExport,
    refreshWorkflow: () => void refreshWorkflow(),
    runWorkflowAction: handleWorkflowAction,
    openMemorySource,
    documentRestored: handleDocumentRestored,
    libraryChanged: handleRecoveryLibraryChanged,
    showNotice,
    closeError: () => setError(""),
    closeProjectManager: () => setProjectManagerOpen(false),
    importProjectPreview: handleImportPreview,
    importProjectConfirm: handleImportConfirm,
    switchProject,
    createProject: handleCreateProject,
    deleteProject: handleDeleteProject,
    closePreflight: () => setPreflightOpen(false),
    refreshPreflight,
    closeAiSettings: () => setAiSettingsOpen(false),
    saveAiSettings: handleSaveAiSettings,
    closeNewDocument: () => setNewDocumentOpen(false),
    createDocument: handleCreateDocument,
    closeDeleteDocument: () => setDeleteDocumentOpen(false),
    deleteDocument: handleDeleteDocument
  };

  return (
    <WorkbenchView
      model={viewModel}
      actions={viewActions}
      workbenchRef={workbenchRef}
      searchInputRef={searchInputRef}
    />
  );
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
