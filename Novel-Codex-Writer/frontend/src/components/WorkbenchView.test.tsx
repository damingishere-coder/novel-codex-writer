import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WorkbenchView,
  type WorkbenchViewActions,
  type WorkbenchViewModel
} from "./WorkbenchView";

const actions = new Proxy({} as WorkbenchViewActions, {
  get: () => () => undefined
});

function model(patch: Partial<WorkbenchViewModel> = {}): WorkbenchViewModel {
  return {
    loading: false,
    error: "",
    notice: "",
    projects: [],
    activeProjectId: "project-1",
    activeProject: { id: "project-1", name: "测试作品", root: "作品/project-1", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    library: undefined,
    documentHistoryLength: 0,
    documentHistoryIndex: -1,
    query: "",
    searchResults: [],
    searchStatus: "idle",
    searchError: "",
    leftCollapsed: false,
    rightVisible: false,
    rightTab: "review",
    dark: false,
    themePreference: "system",
    focusMode: false,
    openGroups: ["chapters"],
    paneWidths: { left: 280, right: 360 },
    workbenchStyle: {},
    selectedPath: "",
    selectedEntry: undefined,
    document: undefined,
    draftContent: "",
    mode: "review",
    dirty: false,
    wordCount: 0,
    saving: false,
    contentLoading: false,
    editorMarks: [],
    selectedAnnotationId: undefined,
    annotationRevealRequest: undefined,
    session: undefined,
    latestChapterReview: undefined,
    chapterReviewBusy: false,
    batchReviewBusy: false,
    chapterReviewMessage: "",
    aiStatus: undefined,
    workflowStatus: undefined,
    workflowLoading: false,
    workflowBusy: false,
    preflight: undefined,
    preflightOpen: false,
    projectManagerOpen: false,
    aiSettingsOpen: false,
    newDocumentOpen: false,
    deleteDocumentOpen: false,
    ...patch
  };
}

function render(current: WorkbenchViewModel) {
  return renderToStaticMarkup(
    <WorkbenchView
      model={current}
      actions={actions}
      workbenchRef={createRef<HTMLElement>()}
      searchInputRef={createRef<HTMLInputElement>()}
    />
  );
}

describe("WorkbenchView", () => {
  it("显示初始化和启动失败状态", () => {
    expect(render(model({ loading: true }))).toContain("正在打开小说工作台");
    expect(render(model({ error: "作品索引损坏" }))).toContain("作品索引损坏");
  });

  it("渲染无文档工作台与流程面板", () => {
    const html = render(model({ rightVisible: true, rightTab: "workflow", notice: "已保存" }));
    expect(html).toContain("测试作品");
    expect(html).toContain("请选择或新建一个 Markdown 文档");
    expect(html).toContain("尚无工作流状态");
    expect(html).toContain("已保存");
  });

  it("没有作品时提供明确的创建或导入入口", () => {
    const html = render(model({ activeProjectId: "", activeProject: undefined }));
    expect(html).toContain("还没有小说作品");
    expect(html).toContain("创建或导入小说");
  });
});
