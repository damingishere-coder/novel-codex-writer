import { lazy, Suspense, useEffect, useId, useRef, useState, type CSSProperties, type Ref } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Activity,
  BookOpen,
  Check,
  ChevronDown,
  Maximize2,
  Minimize2,
  Monitor,
  MoreHorizontal,
  Sparkles,
  FileClock,
  FilePlus2,
  FolderCog,
  Eye,
  EyeOff,
  LoaderCircle,
  Menu,
  Moon,
  Plus,
  Save,
  Search,
  Settings2,
  Sun,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { ActionMenu } from "./ActionMenu";
import type { ThemePreference } from "../lib/preferences";
import { LibrarySidebar } from "./LibrarySidebar";
import { LibrarySearch } from "./LibrarySearch";
import { RecoveryPanel } from "./RecoveryPanel";
import { WorkflowPanel } from "./WorkflowPanel";
import { WritingCockpit } from "./WritingCockpit";
import { MemoryPanel } from "./MemoryPanel";
import type { AnnotationRevealRequest } from "./NovelEditor";
import {
  CHAPTER_WORD_COUNT_MAX,
  CHAPTER_WORD_COUNT_MIN,
  cn,
  formatWordCount,
  getChapterWordCountStatus
} from "../lib/format";
import { DEFAULT_PANE_WIDTHS, PANE_WIDTH_LIMITS, type PaneSide, type PaneWidths } from "../lib/pane-layout";
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
  ProjectImportPreview,
  ReviewAnnotation,
  ReviewSession,
  SearchResult,
  SystemPreflight,
  WorkflowStatus,
  WorkspaceMode
} from "../types";

const MarkdownView = lazy(() => import("./MarkdownView").then((module) => ({ default: module.MarkdownView })));
const NovelEditor = lazy(() => import("./NovelEditor").then((module) => ({ default: module.NovelEditor })));
const ReviewPanel = lazy(() => import("./ReviewPanel").then((module) => ({ default: module.ReviewPanel })));

export interface WorkbenchViewModel {
  loading: boolean;
  error: string;
  notice: string;
  projects: ProjectSummary[];
  activeProjectId: string;
  activeProject?: ProjectSummary;
  library?: LibraryResponse;
  documentHistoryLength: number;
  documentHistoryIndex: number;
  query: string;
  searchResults: SearchResult[];
  searchStatus: "idle" | "loading" | "success" | "error";
  searchError: string;
  leftCollapsed: boolean;
  rightVisible: boolean;
  rightTab: "review" | "workflow" | "memory";
  dark: boolean;
  themePreference: ThemePreference;
  focusMode: boolean;
  openGroups: GroupId[];
  paneWidths: PaneWidths;
  workbenchStyle: CSSProperties;
  selectedPath: string;
  selectedEntry?: DocumentEntry;
  document?: DocumentResponse;
  draftContent: string;
  mode: WorkspaceMode;
  dirty: boolean;
  wordCount: number;
  saving: boolean;
  contentLoading: boolean;
  editorMarks: Array<{ id: string; fromLine: number; toLine: number }>;
  selectedAnnotationId?: string;
  annotationRevealRequest?: AnnotationRevealRequest;
  session?: ReviewSession;
  latestChapterReview?: ChapterReviewRun;
  chapterReviewBusy: boolean;
  batchReviewBusy: boolean;
  chapterReviewMessage: string;
  aiStatus?: AiStatus;
  workflowStatus?: WorkflowStatus;
  workflowLoading: boolean;
  workflowBusy: boolean;
  preflight?: SystemPreflight;
  preflightOpen: boolean;
  projectManagerOpen: boolean;
  aiSettingsOpen: boolean;
  newDocumentOpen: boolean;
  deleteDocumentOpen: boolean;
}

export interface WorkbenchViewActions {
  retry(): void;
  navigateHistory(direction: -1 | 1): void;
  openProjectManager(): void;
  openPreflight(): void;
  setQuery(value: string): void;
  retrySearch(): void;
  openLeftPane(): void;
  toggleLeftPane(): void;
  openNewDocument(): void;
  setMode(mode: WorkspaceMode): void;
  openRightPane(): void;
  closeRightPane(): void;
  setRightTab(tab: "review" | "workflow" | "memory"): void;
  setThemePreference(value: ThemePreference): void;
  toggleFocus(): void;
  toggleGroup(id: GroupId): void;
  selectEntry(entry: DocumentEntry): void;
  openAiSettings(): void;
  changePaneWidth(side: PaneSide, width: number): void;
  save(): void;
  openDeleteDocument(): void;
  changeDraft(value: string): void;
  clickLine(line: number, shiftKey: boolean): void;
  annotationRevealHandled(requestId: number): void;
  selectAnnotation(id: string): void;
  updateAnnotation(id: string, patch: Partial<ReviewAnnotation>): void;
  callAi(id: string, mode?: "new" | "retry"): void;
  acceptSuggestion(id: string): void;
  deleteAnnotation(id: string): void;
  processAll(): void;
  runChapterReview(engine: AiEngine): void;
  acceptFinding(id: string): void;
  dismissFinding(id: string): void;
  locateFinding(id: string): void;
  exportReview(): Promise<void>;
  refreshWorkflow(): void;
  runWorkflowAction(action: string, extra?: Record<string, unknown>): Promise<void>;
  openMemorySource(path: string, line: number): void;
  documentRestored(document: DocumentResponse): void;
  libraryChanged(): Promise<void>;
  showNotice(message: string): void;
  closeError(): void;
  closeProjectManager(): void;
  importProjectPreview(file: File): Promise<ProjectImportPreview>;
  importProjectConfirm(token: string, name?: string): Promise<void>;
  switchProject(id: string): Promise<void>;
  createProject(name: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  closePreflight(): void;
  refreshPreflight(): Promise<void>;
  closeAiSettings(): void;
  saveAiSettings(settings: AiSettingsUpdate): Promise<void>;
  closeNewDocument(): void;
  createDocument(path: string): Promise<void>;
  closeDeleteDocument(): void;
  deleteDocument(): Promise<void>;
}

export function WorkbenchView({
  model,
  actions,
  workbenchRef,
  searchInputRef
}: {
  model: WorkbenchViewModel;
  actions: WorkbenchViewActions;
  workbenchRef: Ref<HTMLElement>;
  searchInputRef: Ref<HTMLInputElement>;
}) {
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [mobileSearch, setMobileSearch] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === "undefined" ? 1200 : window.innerWidth);
  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const drawerSelector = viewportWidth < 1200 && !model.leftCollapsed ? ".library-sidebar"
    : viewportWidth < 1024 && model.rightVisible ? ".right-workbench" : null;
  useEffect(() => {
    if (mobileSearch) document.querySelector<HTMLInputElement>('[aria-label="搜索当前小说资料"]')?.focus();
  }, [mobileSearch]);
  useEffect(() => {
    if (!drawerSelector) return;
    const drawer = document.querySelector<HTMLElement>(drawerSelector);
    const workspace = document.querySelector<HTMLElement>(".document-workspace");
    const previous = document.activeElement as HTMLElement | null;
    if (workspace) workspace.inert = true;
    if (!mobileSearch) drawer?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = Array.from(drawer?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, [href], [tabindex="0"]') ?? []).filter((item) => item.getClientRects().length);
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    };
    drawer?.addEventListener("keydown", trap);
    return () => {
      if (workspace) workspace.inert = false;
      drawer?.removeEventListener("keydown", trap);
      if (previous?.isConnected && (!document.activeElement || document.activeElement === document.body || document.activeElement.classList.contains("pane-backdrop") || drawer?.contains(document.activeElement))) previous.focus();
    };
  }, [drawerSelector, model.loading]);
  function openRecovery() {
    if (model.dirty) { actions.showNotice("请先保存当前草稿，再查看历史与恢复。"); return; }
    setRecoveryOpen(true);
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      if (model.focusMode) actions.toggleFocus();
      else if (window.innerWidth < 1200 && !model.leftCollapsed) actions.toggleLeftPane();
      else if (window.innerWidth < 1024 && model.rightVisible) actions.closeRightPane();
      setMobileSearch(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [model.focusMode, model.leftCollapsed, model.rightVisible, actions]);
  if (model.loading) return <LoadingScreen />;
  if (model.error && !model.projects.length) return <FailureScreen message={model.error} onRetry={actions.retry} />;

  return (
    <div className="workbench-shell">
      <header className={cn("app-toolbar", mobileSearch && "search-open")}>
        <div className="app-brand" aria-label="小说创作台"><BookOpen size={20} /><span>创作台</span></div>
        <ActionMenu label={model.activeProject?.name ?? "未选择作品"} icon={<ChevronDown size={16} />} className="project-menu">
          <p className="menu-caption">切换作品</p>
          {model.projects.map((project) => <button key={project.id} aria-pressed={project.id === model.activeProjectId} onClick={() => void actions.switchProject(project.id)}><BookOpen size={16} /><span>{project.name}</span>{project.id === model.activeProjectId ? <Check size={14} /> : null}</button>)}
          <div className="menu-divider" />
          <button onClick={actions.openProjectManager}><FolderCog size={16} />管理作品 · 新建与导入</button>
          <button onClick={actions.openNewDocument} disabled={!model.activeProjectId}><Plus size={16} />新建文档</button>
          <button onClick={openRecovery}><FileClock size={16} />历史、回收站与导出</button>
        </ActionMenu>
        <LibrarySearch key={model.activeProjectId} query={model.query} results={model.searchResults} status={model.searchStatus} error={model.searchError}
          enabled={Boolean(model.activeProjectId)} inputRef={searchInputRef} onQuery={actions.setQuery} onSelect={actions.selectEntry}
          onRetry={actions.retrySearch} onMobileOpen={() => setMobileSearch(true)} onClose={() => setMobileSearch(false)} />
        <button className="icon-button search-toggle" aria-label="搜索资料" onClick={() => setMobileSearch(!mobileSearch)}><Search size={17} /></button>
        <ActionMenu label="外观" icon={model.themePreference === "system" ? <Monitor size={17} /> : model.dark ? <Moon size={17} /> : <Sun size={17} />}>
          <p className="menu-caption">外观模式</p>
          {(["light", "dark", "system"] as ThemePreference[]).map((value) => <button key={value} aria-pressed={model.themePreference === value} onClick={() => actions.setThemePreference(value)}>
            {value === "light" ? <Sun size={16} /> : value === "dark" ? <Moon size={16} /> : <Monitor size={16} />}<span>{value === "light" ? "浅色" : value === "dark" ? "深色" : "跟随系统"}</span>{model.themePreference === value ? <Check size={14} /> : null}
          </button>)}
        </ActionMenu>
        <ActionMenu label="设置" icon={<Settings2 size={17} />}>
          <button onClick={actions.openAiSettings}><Sparkles size={16} />AI 设置</button>
          <button onClick={actions.openPreflight}><Activity size={16} />启动预检</button>
        </ActionMenu>
      </header>

      <main
        ref={workbenchRef}
        className={cn("workbench-grid", model.leftCollapsed && "left-collapsed", !model.rightVisible && "right-collapsed", model.focusMode && "focus-mode")}
        style={model.workbenchStyle}
      >
        <button className={cn("pane-backdrop", !model.leftCollapsed ? "for-library" : model.rightVisible ? "for-assistant" : "")} aria-label="收起侧栏" onClick={() => { if (!model.leftCollapsed) actions.toggleLeftPane(); else actions.closeRightPane(); }} />
        <LibrarySidebar
          groups={model.library?.groups ?? []}
          selectedPath={model.selectedPath}
          collapsed={model.leftCollapsed}
          openGroups={model.openGroups}
          aiConnected={Boolean(model.aiStatus?.deepseek.available || model.aiStatus?.codex.available)}
          onToggleCollapsed={actions.toggleLeftPane}
          onToggleGroup={actions.toggleGroup}
          onSelect={(entry) => { actions.selectEntry(entry); setMobileSearch(false); }}
          onOpenAiSettings={actions.openAiSettings}
          onNewDocument={actions.openNewDocument}
          canCreate={Boolean(model.activeProjectId)}
        />

        {!model.leftCollapsed ? (
          <PaneResizeHandle
            side="left"
            value={model.paneWidths.left}
            onChange={(width) => actions.changePaneWidth("left", width)}
            onReset={() => actions.changePaneWidth("left", DEFAULT_PANE_WIDTHS.left)}
          />
        ) : null}

        <section className="document-workspace">
          <div className="document-toolbar">
            <button className="icon-button library-toggle" onClick={actions.toggleLeftPane} aria-label="打开资料库" title="打开资料库"><Menu size={17} /></button>
            <div className="document-title"><span className="eyebrow">{model.selectedEntry?.groupId === "chapters" ? "正文" : "创作资料"}</span><strong title={model.selectedPath}>{model.selectedEntry?.fileName ?? "开始你的创作"}</strong></div>
            <div className="document-stats"><span role="status">{model.saving ? "保存中…" : model.dirty ? "未保存" : model.document ? "已保存" : ""}</span></div>
            <button className="icon-button" onClick={actions.toggleFocus} aria-pressed={model.focusMode} aria-label={model.focusMode ? "退出专注" : "专注模式"} title={model.focusMode ? "退出专注（Esc）" : "专注模式"}>{model.focusMode ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
            <ActionMenu label="文档操作" icon={<MoreHorizontal size={17} />}>
              <button onClick={actions.openNewDocument} disabled={!model.activeProjectId}><Plus size={16} />新建文档</button>
              <button onClick={openRecovery}><FileClock size={16} />历史与回收站</button>
              <button onClick={actions.openDeleteDocument} disabled={!model.selectedPath} className="danger"><Trash2 size={16} />移到回收站</button>
            </ActionMenu>
          </div>
          <div className="document-controls">
            <div className="history-buttons">
              <button className="icon-button" aria-label="返回上一份文档" disabled={model.documentHistoryIndex <= 0} onClick={() => actions.navigateHistory(-1)}><ArrowLeft size={15} /></button>
              <button className="icon-button" aria-label="前进到下一份文档" disabled={model.documentHistoryIndex < 0 || model.documentHistoryIndex >= model.documentHistoryLength - 1} onClick={() => actions.navigateHistory(1)}><ArrowRight size={15} /></button>
            </div>
            <div className="mode-switch" aria-label="文档模式">
              {(["preview", "review", "edit"] as WorkspaceMode[]).map((item) => <button key={item} aria-pressed={model.mode === item} className={model.mode === item ? "active" : ""} onClick={() => actions.setMode(item)}>{item === "preview" ? "阅读" : item === "review" ? "审校" : "编辑"}</button>)}
            </div>
            {model.mode === "edit" || model.dirty ? <button className="primary-button save-button" onClick={actions.save} disabled={!model.dirty || model.saving}>{model.saving ? <LoaderCircle size={14} className="animate-spin" /> : <Save size={14} />}保存</button> : null}
            <button className="assistant-toggle soft-button" aria-label="创作助手" aria-expanded={model.rightVisible} onClick={() => model.rightVisible ? actions.closeRightPane() : actions.openRightPane()}><Sparkles size={15} /><span>创作助手</span></button>
          </div>
          <div className="document-surface">
            {model.contentLoading ? (
              <div className="surface-state"><LoaderCircle className="animate-spin" />正在读取文档…</div>
            ) : !model.activeProjectId ? (
              <div className="surface-state empty-project-state">
                <BookOpen size={28} />
                <strong>还没有小说作品</strong>
                <span>创建一本新小说，或从本应用导出的 ZIP 安全导入。</span>
                <button className="primary-button" onClick={actions.openProjectManager}><Plus size={16} />创建或导入小说</button>
              </div>
            ) : !model.document ? (
              <div className="surface-state document-empty"><FilePlus2 size={30} /><strong>选择一个章节，继续创作</strong><span>请选择或新建一个 Markdown 文档</span><div className="empty-chapter-list">{model.library?.groups.find((group) => group.id === "chapters")?.entries.map((entry) => <button className="document-row" key={entry.path} onClick={() => actions.selectEntry(entry)}>{entry.title}</button>)}</div><button className="soft-button" onClick={actions.openLeftPane}>浏览作品资料</button></div>
            ) : model.mode === "preview" ? (
              <Suspense fallback={<div className="surface-state"><LoaderCircle className="animate-spin" />正在载入预览…</div>}>
                <div className="markdown-preview"><MarkdownView content={model.draftContent} /></div>
              </Suspense>
            ) : (
              <Suspense fallback={<div className="surface-state"><LoaderCircle className="animate-spin" />正在载入编辑器…</div>}>
                <NovelEditor
                  value={model.draftContent}
                  mode={model.mode}
                  annotations={model.editorMarks}
                  selectedAnnotationId={model.selectedAnnotationId}
                  revealRequest={model.annotationRevealRequest}
                  onChange={actions.changeDraft}
                  onLineClick={actions.clickLine}
                  onRevealHandled={actions.annotationRevealHandled}
                />
              </Suspense>
            )}
          </div>
          <footer className="document-footer"><span>{model.mode === "review" ? "点击行号添加批注 · Shift 多选" : model.mode === "edit" ? "编辑完成后保存正文" : "阅读模式"}</span><WordCount wordCount={model.wordCount} isChapter={model.selectedEntry?.groupId === "chapters"} /></footer>
        </section>

        {model.rightVisible ? (
          <PaneResizeHandle
            side="right"
            value={model.paneWidths.right}
            onChange={(width) => actions.changePaneWidth("right", width)}
            onReset={() => actions.changePaneWidth("right", DEFAULT_PANE_WIDTHS.right)}
          />
        ) : null}

        {model.rightVisible ? (
          <aside className="right-workbench" aria-label="创作助手面板">
            <div className="assistant-heading"><Sparkles size={18} /><strong>创作助手</strong><span>陪你写好每一章</span></div>
            <nav className="right-tabs" aria-label="右侧工作台">
              <button aria-pressed={model.rightTab === "workflow"} className={model.rightTab === "workflow" ? "active" : ""} onClick={() => actions.setRightTab("workflow")}>创作</button>
              <button aria-pressed={model.rightTab === "review"} className={model.rightTab === "review" ? "active" : ""} onClick={() => actions.setRightTab("review")}>审校</button>
              <button aria-pressed={model.rightTab === "memory"} className={model.rightTab === "memory" ? "active" : ""} onClick={() => actions.setRightTab("memory")}>连续性</button>
              <button className="icon-button" onClick={actions.closeRightPane} aria-label="关闭右栏" title="关闭右栏"><X size={15} /></button>
            </nav>
            {model.rightTab === "review" ? <Suspense fallback={<div className="surface-state"><LoaderCircle className="animate-spin" />正在载入审校面板…</div>}><ReviewPanel
              annotations={model.session?.annotations ?? []}
              chapterReview={model.latestChapterReview}
              isChapter={model.selectedEntry?.groupId === "chapters"}
              reviewBusy={model.chapterReviewBusy}
              batchBusy={model.batchReviewBusy}
              reviewMessage={model.chapterReviewMessage}
              selectedId={model.selectedAnnotationId}
              aiStatus={model.aiStatus}
              onSelect={actions.selectAnnotation}
              onClose={actions.closeRightPane}
              onOpenSettings={actions.openAiSettings}
              onUpdate={actions.updateAnnotation}
              onCallAi={(id) => actions.callAi(id)}
              onAccept={actions.acceptSuggestion}
              onIgnore={(id) => actions.updateAnnotation(id, { status: "ignored" })}
              onRegenerate={(id) => actions.callAi(id, "retry")}
              onDelete={actions.deleteAnnotation}
              onProcessAll={actions.processAll}
              onRunChapterReview={actions.runChapterReview}
              onAcceptFinding={actions.acceptFinding}
              onDismissFinding={actions.dismissFinding}
              onLocateFinding={actions.locateFinding}
              onExport={actions.exportReview}
            /></Suspense> : null}
            {model.rightTab === "workflow" ? (
              <div className="creation-scroll">
              <WritingCockpit project={model.activeProject} status={model.workflowStatus} loading={model.workflowLoading} busy={model.workflowBusy} onAction={actions.runWorkflowAction} onNotice={actions.showNotice} onOpenWorkflow={() => document.querySelector<HTMLDetailsElement>(".workflow-advanced")?.setAttribute("open", "")} />
              <WorkflowPanel
                status={model.workflowStatus}
                loading={model.workflowLoading}
                busy={model.workflowBusy}
                onRefresh={actions.refreshWorkflow}
                onAction={actions.runWorkflowAction}
              />
              </div>
            ) : null}
            {model.rightTab === "memory" ? (
              <MemoryPanel projectId={model.activeProjectId} onOpenSource={actions.openMemorySource} onNotice={actions.showNotice} />
            ) : null}
          </aside>
        ) : null}
      </main>

      {recoveryOpen ? <Modal title="历史、回收站与导出" subtitle="查看历史版本、恢复误删资料，或导出当前作品。" onClose={() => setRecoveryOpen(false)}><RecoveryPanel projectId={model.activeProjectId} document={model.document} onDocumentRestored={actions.documentRestored} onLibraryChanged={actions.libraryChanged} onNotice={actions.showNotice} /></Modal> : null}
      {model.notice ? <div className="toast" role="status"><Check size={16} />{model.notice}</div> : null}
      {model.error ? <ErrorDialog message={model.error} onClose={actions.closeError} /> : null}
      {model.projectManagerOpen ? (
        <ProjectManager
          projects={model.projects}
          activeProjectId={model.activeProjectId}
          onClose={actions.closeProjectManager}
          onSwitch={actions.switchProject}
          onCreate={actions.createProject}
          onDelete={actions.deleteProject}
          onImportPreview={actions.importProjectPreview}
          onImportConfirm={actions.importProjectConfirm}
        />
      ) : null}
      {model.preflightOpen ? (
        <PreflightDialog preflight={model.preflight} onClose={actions.closePreflight} onRefresh={actions.refreshPreflight} />
      ) : null}
      {model.aiSettingsOpen && model.aiStatus ? (
        <AiSettingsDialog status={model.aiStatus} onClose={actions.closeAiSettings} onSave={actions.saveAiSettings} />
      ) : null}
      {model.newDocumentOpen ? <NewDocumentDialog onClose={actions.closeNewDocument} onCreate={actions.createDocument} /> : null}
      {model.deleteDocumentOpen ? (
        <ConfirmDialog
          title="把文档移到回收站？"
          description={`“${model.selectedEntry?.title ?? model.selectedPath}”不会永久删除，可以从 .trash 中恢复。`}
          confirmLabel="移到回收站"
          danger
          onClose={actions.closeDeleteDocument}
          onConfirm={actions.deleteDocument}
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
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: value };
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

function ProjectManager({ projects, activeProjectId, onClose, onSwitch, onCreate, onDelete, onImportPreview, onImportConfirm }: {
  projects: ProjectSummary[];
  activeProjectId: string;
  onClose: () => void;
  onSwitch: (id: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onImportPreview: (file: File) => Promise<ProjectImportPreview>;
  onImportConfirm: (token: string, name?: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [importPreview, setImportPreview] = useState<ProjectImportPreview>();
  const [importName, setImportName] = useState("");
  return (
    <Modal title="管理作品" subtitle="删除会移到回收站，不会永久清除" onClose={onClose}>
      <div className="project-list">
        {projects.map((project) => (
          <div key={project.id} className={cn("project-row", project.id === activeProjectId && "active")}>
            <BookOpen size={17} />
            <span><strong>{project.name}</strong><small>{project.id === activeProjectId ? "当前作品" : "独立资料库"}</small></span>
            {project.id !== activeProjectId ? (
              <button className="soft-button" disabled={busy} onClick={async () => { if (busy) return; setBusy(true); try { await onSwitch(project.id); } finally { setBusy(false); } }}>切换</button>
            ) : null}
            <button className="icon-button danger" disabled={busy} onClick={() => setPendingDelete(project.id)} title="移到回收站"><Trash2 size={15} /></button>
          </div>
        ))}
      </div>
      <form className="modal-form-row" onSubmit={async (event) => { event.preventDefault(); if (!name.trim()) return; setBusy(true); setActionError(""); try { await onCreate(name.trim()); setName(""); } catch (caught) { setActionError(errorMessage(caught)); } finally { setBusy(false); } }}>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="输入新小说名称" />
        <button className="primary-button" disabled={busy || !name.trim()}><Plus size={15} />新建小说</button>
      </form>
      <section className="project-import-card">
        <div><strong>从 ZIP 安全导入</strong><p>先预检路径、结构和大小；确认后始终创建新项目，绝不覆盖现有作品。</p></div>
        {!importPreview ? (
          <label className={cn("soft-button", busy && "disabled")}><Upload size={15} />选择导出的 ZIP<input type="file" accept=".zip,application/zip" hidden disabled={busy} onChange={async (event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            setBusy(true);
            setActionError("");
            try {
              const preview = await onImportPreview(file);
              setImportPreview(preview);
              setImportName(preview.projectName);
            } catch (caught) {
              setActionError(errorMessage(caught));
            } finally {
              setBusy(false);
            }
          }} /></label>
        ) : (
          <div className="import-preview">
            <dl><div><dt>原作品</dt><dd>{importPreview.projectName}</dd></div><div><dt>文件</dt><dd>{importPreview.fileCount} 个</dd></div><div><dt>内容大小</dt><dd>{Math.ceil(importPreview.totalBytes / 1024)} KiB</dd></div></dl>
            <label className="field"><span>新项目名称</span><input value={importName} onChange={(event) => setImportName(event.target.value)} maxLength={120} /></label>
            {importPreview.warnings.map((warning) => <p key={warning} className="setup-note">{warning}</p>)}
            <div className="modal-actions"><button className="soft-button" disabled={busy} onClick={() => setImportPreview(undefined)}>取消导入</button><button className="primary-button" disabled={busy || !importName.trim()} onClick={async () => {
              setBusy(true);
              setActionError("");
              try {
                await onImportConfirm(importPreview.token, importName.trim());
                setImportPreview(undefined);
                onClose();
              } catch (caught) {
                setActionError(errorMessage(caught));
              } finally {
                setBusy(false);
              }
            }}>{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Upload size={15} />}确认并创建新项目</button></div>
          </div>
        )}
      </section>
      {pendingDelete ? (
        <div className="inline-confirm">
          <strong>确认移到回收站？</strong>
          <p>作品目录会被移动到 `.trash/projects/`，之后仍可恢复。</p>
          <button className="soft-button" onClick={() => setPendingDelete(undefined)}>取消</button>
          <button className="danger-button" onClick={async () => { setBusy(true); setActionError(""); try { await onDelete(pendingDelete); setPendingDelete(undefined); } catch (caught) { setActionError(errorMessage(caught)); } finally { setBusy(false); } }} disabled={busy}><Trash2 size={15} />确认移动</button>
        </div>
      ) : null}
      {actionError ? <p className="form-error" role="alert">{actionError}</p> : null}
    </Modal>
  );
}

function PreflightDialog({ preflight, onClose, onRefresh }: {
  preflight?: SystemPreflight;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="启动预检" subtitle="AI 不可用只会降级审校，不阻止阅读和编辑" onClose={onClose}>
      {preflight ? (
        <>
          <div className={cn("preflight-summary", preflight.ready ? "ready" : "blocked")}>
            <strong>{preflight.ready ? "本机写作环境已就绪" : "有阻断项需要处理"}</strong>
            <span>{preflight.runtime.mode === "native" ? "Windows 原生" : preflight.runtime.mode === "docker" ? "Docker 备用" : "自定义"} · {preflight.runtime.host}:{preflight.runtime.port ?? "当前端口"}</span>
          </div>
          <div className="preflight-checks">
            {preflight.checks.map((item) => (
              <div key={item.id} className={`preflight-check ${item.state}`}>
                {item.state === "pass" ? <Check size={16} /> : <CircleAlertIcon />}
                <span><strong>{item.label}{item.blocking ? <small>必要</small> : null}</strong><p>{item.message}</p></span>
              </div>
            ))}
          </div>
        </>
      ) : <div className="surface-state"><LoaderCircle className="animate-spin" />正在读取本机状态…</div>}
      <div className="modal-actions"><button className="soft-button" disabled={busy} onClick={async () => { setBusy(true); try { await onRefresh(); } finally { setBusy(false); } }}><RefreshIcon busy={busy} />重新检查</button><button className="primary-button" onClick={onClose}>进入工作台</button></div>
    </Modal>
  );
}

function CircleAlertIcon() {
  return <span className="preflight-alert">!</span>;
}

function RefreshIcon({ busy }: { busy: boolean }) {
  return <LoaderCircle size={15} className={busy ? "animate-spin" : undefined} />;
}

function AiSettingsDialog({ status, onClose, onSave }: { status: AiStatus; onClose: () => void; onSave: (settings: AiSettingsUpdate) => Promise<void> }) {
  const [settings, setSettings] = useState(status.settings);
  const [deepseekApiKey, setDeepseekApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
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
      {actionError ? <p className="form-error" role="alert">{actionError}</p> : null}
      <div className="modal-actions"><button className="soft-button" onClick={onClose}>取消</button><button className="primary-button" onClick={async () => { setBusy(true); setActionError(""); try { await onSave({ ...settings, ...(deepseekApiKey.trim() ? { deepseekApiKey: deepseekApiKey.trim() } : {}) }); } catch (caught) { setActionError(errorMessage(caught)); } finally { setBusy(false); } }} disabled={busy}>{busy && <LoaderCircle size={15} className="animate-spin" />}保存设置</button></div>
    </Modal>
  );
}

function ProviderStatus({ name, available, detail, selected, onSelect }: { name: string; available: boolean; detail: string; selected: boolean; onSelect: () => void }) {
  return <button type="button" className={cn("provider-status", available && "online", selected && "selected")} onClick={onSelect} aria-pressed={selected}><span className={cn("status-dot", available && "online")} /><strong>{name}</strong><span className="provider-radio">{selected ? <Check size={12} /> : null}</span><small>{detail}</small></button>;
}

function NewDocumentDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (path: string) => Promise<void> }) {
  const [path, setPath] = useState("正文/第001章_新章节.md");
  const [busy, setBusy] = useState(false);
  return <Modal title="新建 Markdown 文档" subtitle="路径只能位于当前小说目录内" onClose={onClose}><form onSubmit={async (event) => { event.preventDefault(); if (busy) return; setBusy(true); try { await onCreate(path); } finally { setBusy(false); } }}><label className="field"><span>文档路径</span><input autoFocus value={path} onChange={(event) => setPath(event.target.value)} disabled={busy} /></label><div className="modal-actions"><button type="button" className="soft-button" onClick={onClose} disabled={busy}>取消</button><button className="primary-button" disabled={busy}>{busy ? <LoaderCircle size={15} className="animate-spin" /> : <FilePlus2 size={15} />}{busy ? "创建中" : "创建文档"}</button></div></form></Modal>;
}

function ConfirmDialog({ title, description, confirmLabel, danger, onClose, onConfirm }: { title: string; description: string; confirmLabel: string; danger?: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return <Modal title={title} subtitle={description} onClose={onClose}><div className="modal-actions"><button className="soft-button" onClick={onClose}>取消</button><button className={danger ? "danger-button" : "primary-button"} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}>{busy && <LoaderCircle size={15} className="animate-spin" />}{confirmLabel}</button></div></Modal>;
}

function ErrorDialog({ message, onClose }: { message: string; onClose: () => void }) {
  return <Modal title="操作没有完成" subtitle={message} onClose={onClose}><div className="modal-actions"><button className="primary-button" onClick={onClose}>我知道了</button></div></Modal>;
}

function Modal({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) {
  const cardRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const card = cardRef.current;
    const preferred = card?.querySelector<HTMLElement>(
      "[autofocus], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex='-1'])"
    );
    (preferred ?? card)?.focus();
    // Refreshing a history list can remove the focused button. Escape and Tab
    // must still work when the browser moves focus back to the document body.
    const recoverFocus = (event: KeyboardEvent) => {
      if (event.defaultPrevented || Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) !== card) return;
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      else if (event.key === "Tab" && !card?.contains(document.activeElement)) {
        event.preventDefault();
        (card?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)") ?? card)?.focus();
      }
    };
    document.addEventListener("keydown", recoverFocus);
    return () => {
      document.removeEventListener("keydown", recoverFocus);
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    };
  }, []);

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(cardRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"
    ) ?? []).filter((element) => !element.hasAttribute("hidden"));
    if (!focusable.length) {
      event.preventDefault();
      cardRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && (document.activeElement === first || !cardRef.current?.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={cardRef} className="modal-card" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={handleKeyDown}><header><div><h2 id={titleId}>{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose} aria-label="关闭弹窗" title="关闭弹窗"><X size={17} /></button></header><div className="modal-body">{children}</div></section></div>;
}

function LoadingScreen() {
  return <div className="full-state"><LoaderCircle className="animate-spin" /><strong>正在打开小说工作台</strong></div>;
}

function FailureScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="full-state"><span className="failure-mark"><X size={20} /></span><strong>无法读取作品库</strong><p>{message}</p><button className="primary-button" onClick={onRetry}>重新尝试</button></div>;
}

function errorMessage(caught: unknown) {
  return caught instanceof Error ? caught.message : "发生未知错误";
}
