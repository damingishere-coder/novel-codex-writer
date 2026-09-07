import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowNextStepId, WorkflowNextStepMode, WorkflowStatus } from "../types";
import { WorkflowPrimaryAction } from "./WorkflowPrimaryAction";

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [value, () => undefined]
}));
afterEach(() => vi.unstubAllGlobals());

const steps: Array<[WorkflowNextStepId, WorkflowNextStepMode, string]> = [
  ["resolve_patch_classification", "open_panel", "确认旧 patch 分类"],
  ["repair_taskbook", "server_action", "重新生成任务书"],
  ["resolve_blocker", "codex_prompt", "处理工作流阻断"],
  ["create_blueprint", "codex_prompt", "创建第001章细纲"],
  ["generate_taskbook", "server_action", "生成本章任务书"],
  ["draft_body", "codex_prompt", "创作第001章正文"],
  ["check_body", "server_action", "检查当前正文"],
  ["revise_body", "codex_prompt", "按审查结果修改正文"],
  ["create_commit", "codex_prompt", "生成章节提交记录"],
  ["create_memory_patch", "codex_prompt", "生成记忆更新 patch"],
  ["apply_patch", "confirm_action", "确认并应用记忆更新"],
  ["prepare_next_chapter", "codex_prompt", "准备第002章"]
];

function status(id: WorkflowNextStepId, mode: WorkflowNextStepMode, label: string): WorkflowStatus {
  return {
    schemaVersion: 2,
    projectId: "novel-test",
    chapter: 1,
    state: id === "prepare_next_chapter" ? "finalized" : "needs_changes",
    artifacts: [],
    recommendedAction: id === "apply_patch" ? "apply_patch" : "copy_to_codex",
    recommendation: "兼容字段",
    nextStep: {
      id,
      mode,
      label,
      reason: "明确原因",
      ...(mode === "server_action" || mode === "confirm_action" ? { serverAction: id === "repair_taskbook" || id === "generate_taskbook" ? "generate_taskbook" as const : id === "check_body" ? "check_body" as const : "apply_patch" as const } : {}),
      requiresConfirmation: mode === "confirm_action" || mode === "open_panel" || id === "draft_body" || id === "revise_body"
    },
    reviewContext: [],
    legacyPatchChoices: []
  };
}

describe("WorkflowPrimaryAction", () => {
  it.each(steps)("%s 任意状态只渲染一个主操作", (id, mode, label) => {
    const html = renderToStaticMarkup(<WorkflowPrimaryAction status={status(id, mode, label)} busy={false} onAction={async () => undefined} onNotice={() => undefined} onOpenWorkflow={() => undefined} />);
    expect(html).toContain(label);
    expect(html.match(/primary-button/g)).toHaveLength(1);
  });
});


describe("主操作的执行与确认边界", () => {
  function mount(current: WorkflowStatus, busy = false) {
    const props = { status: current, busy, onAction: vi.fn(async () => undefined), onNotice: vi.fn(), onOpenWorkflow: vi.fn() };
    const element = WorkflowPrimaryAction(props);
    return { ...props, click: element.props.onClick as () => void };
  }
  it("复制包含上下文的任务，只反馈复制结果，不触发后端创作", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const current = status("draft_body", "codex_prompt", "创作第001章正文");
    current.nextStep.targetPath = "正文/第1章.md";
    current.reviewContext = [{ role: "测试资料", path: "大纲/细纲.md", missing: false, stale: false, revision: "revision-for-test" }];
    const view = mount(current);
    view.click();
    await vi.waitFor(() => expect(view.onNotice).toHaveBeenCalledWith(expect.stringContaining("请交给 Codex 执行")));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("目标文档：正文/第1章.md"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("大纲/细纲.md @ revision-for"));
    expect(view.onAction).not.toHaveBeenCalled();
  });
  it("剪贴板被拒绝时报告失败", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => { throw new Error("权限被拒绝"); } } });
    const view = mount(status("draft_body", "codex_prompt", "创作正文"));
    view.click();
    await vi.waitFor(() => expect(view.onNotice).toHaveBeenCalledWith("复制失败：权限被拒绝"));
    expect(view.onAction).not.toHaveBeenCalled();
  });
  it("应用记忆更新必须经过确认，取消时零执行", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("window", { confirm });
    const current = status("apply_patch", "confirm_action", "应用记忆更新");
    current.artifacts = [{ id: "memoryPatch", path: "记忆更新/第1章.json", status: "ready", label: "记忆更新", message: "就绪" }];
    const cancelled = mount(current);
    cancelled.click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(cancelled.onAction).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    const approved = mount(current);
    approved.click();
    expect(approved.onAction).toHaveBeenCalledWith("apply_patch", { patchPath: "记忆更新/第1章.json", confirmed: true });
  });
  it("忙碌期间与同一事件循环的重复点击不会重复执行", () => {
    const view = mount(status("generate_taskbook", "server_action", "生成任务书"));
    view.click(); view.click();
    expect(view.onAction).toHaveBeenCalledOnce();
    const busy = mount(status("generate_taskbook", "server_action", "生成任务书"), true);
    busy.click();
    expect(busy.onAction).not.toHaveBeenCalled();
  });
  it("缺失动作或 patch 时给出可恢复说明", () => {
    const missing = status("check_body", "server_action", "检查正文");
    delete missing.nextStep.serverAction;
    const view = mount(missing);
    view.click();
    expect(view.onNotice).toHaveBeenCalledWith(expect.stringContaining("缺少可执行动作"));
    const patch = mount(status("apply_patch", "confirm_action", "应用记忆更新"));
    patch.click();
    expect(patch.onNotice).toHaveBeenCalledWith(expect.stringContaining("没有找到"));
    expect(patch.onAction).not.toHaveBeenCalled();
  });
  it("需要人工处理时只打开流程面板", () => {
    const view = mount(status("resolve_patch_classification", "open_panel", "确认分类"));
    view.click();
    expect(view.onOpenWorkflow).toHaveBeenCalledOnce();
    expect(view.onAction).not.toHaveBeenCalled();
  });
});
