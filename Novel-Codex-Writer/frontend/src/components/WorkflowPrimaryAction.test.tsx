import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkflowNextStepId, WorkflowNextStepMode, WorkflowStatus } from "../types";
import { WorkflowPrimaryAction } from "./WorkflowPrimaryAction";

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
