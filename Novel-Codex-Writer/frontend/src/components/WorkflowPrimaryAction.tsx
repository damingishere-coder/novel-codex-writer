import { useRef, useState } from "react";
import { Clipboard, LoaderCircle, Play, ShieldCheck } from "lucide-react";
import type { WorkflowStatus } from "../types";

interface WorkflowPrimaryActionProps {
  status: WorkflowStatus;
  busy: boolean;
  onAction(action: string, extra?: Record<string, unknown>): Promise<void>;
  onNotice(message: string): void;
  onOpenWorkflow(): void;
}

function codexPrompt(status: WorkflowStatus) {
  const context = status.reviewContext
    .map((item) => `- ${item.role}: ${item.path} @ ${item.revision?.slice(0, 12) ?? "missing"}`)
    .join("\n");
  const target = status.nextStep.targetPath ? `\n目标文档：${status.nextStep.targetPath}` : "";
  return `请使用 webnovel-writer Skill 为当前小说执行“${status.nextStep.label}”。\n章节：第${String(status.chapter).padStart(3, "0")}章${target}\n原因：${status.nextStep.reason}\n保持作者确认、revision 和 memory patch 审计语义，不覆盖现有正式正文。\n上下文清单：\n${context}`;
}

export function WorkflowPrimaryAction({ status, busy, onAction, onNotice, onOpenWorkflow }: WorkflowPrimaryActionProps) {
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  async function run() {
    if (running.current || busy) return;
    running.current = true;
    setPending(true);
    try { await execute(); }
    catch (error) { onNotice(error instanceof Error ? error.message : "执行失败，请重新检查当前状态"); }
    finally { running.current = false; setPending(false); }
  }
  async function execute() {
    const step = status.nextStep;
    if (step.mode === "open_panel") {
      onOpenWorkflow();
      return;
    }
    if (step.mode === "codex_prompt") {
      try {
        await navigator.clipboard.writeText(codexPrompt(status));
        onNotice(`已复制“${step.label}”任务，请交给 Codex 执行`);
      } catch (caught) {
        onNotice(caught instanceof Error ? `复制失败：${caught.message}` : "复制失败：浏览器未授权访问剪贴板");
      }
      return;
    }
    if (!step.serverAction) {
      onNotice("当前步骤缺少可执行动作，请打开高级操作查看诊断。");
      return;
    }
    const extra: Record<string, unknown> = {};
    if (step.id === "apply_patch") {
      const patchPath = status.artifacts.find((item) => item.id === "memoryPatch")?.path;
      if (!patchPath) {
        onNotice("没有找到待应用的 memory patch，请重新诊断。");
        return;
      }
      if (!window.confirm("确认应用这个 memory patch？系统会保留事务和审计记录，但会更新当前记忆投影。")) return;
      extra.patchPath = patchPath;
      extra.confirmed = true;
    }
    await onAction(step.serverAction, extra);
  }

  const Icon = busy ? LoaderCircle : status.nextStep.mode === "codex_prompt" ? Clipboard : status.nextStep.requiresConfirmation ? ShieldCheck : Play;
  return (
    <button className="primary-button workflow-primary-action" disabled={busy || pending} onClick={() => void run()} title={status.nextStep.label}>
      <Icon size={16} className={busy ? "animate-spin" : undefined} />
      {busy || pending ? "正在执行…" : status.nextStep.mode === "codex_prompt" ? "复制任务给 Codex" : status.nextStep.label}
    </button>
  );
}
