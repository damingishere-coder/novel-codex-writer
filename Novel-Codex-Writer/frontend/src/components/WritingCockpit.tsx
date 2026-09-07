import { CircleAlert, LoaderCircle } from "lucide-react";
import type { ProjectSummary, WorkflowStatus } from "../types";
import { WorkflowPrimaryAction } from "./WorkflowPrimaryAction";

export function WritingCockpit({ project, status, loading, busy, onAction, onNotice, onOpenWorkflow }: {
  project?: ProjectSummary;
  status?: WorkflowStatus;
  loading: boolean;
  busy: boolean;
  onAction(action: string, extra?: Record<string, unknown>): Promise<void>;
  onNotice(message: string): void;
  onOpenWorkflow(): void;
}) {
  if (!project) return null;
  if (loading) return <section className="writing-cockpit is-loading"><LoaderCircle className="animate-spin" size={17} />正在读取创作进度…</section>;
  if (!status) return <section className="writing-cockpit is-blocked"><CircleAlert size={17} />暂时无法读取创作进度，请点击下方刷新按钮重新诊断。</section>;
  const total = Math.max(status.artifacts.length, 1);
  const completed = status.artifacts.filter((item) => item.status === "ready" || item.status === "finalized").length;
  return (
    <section className={`writing-cockpit state-${status.state}`} aria-label="下一章写作驾驶舱">
      <div className="cockpit-summary">
        <p className="eyebrow">{project.name} · 第{String(status.chapter).padStart(3, "0")}章</p>
        <strong>创作进度 {completed}/{total}</strong>
        <div className="cockpit-progress" aria-label={`创作进度 ${completed}/${total}`}><span style={{ width: `${completed / total * 100}%` }} /></div>
      </div>
      <div className="cockpit-reason"><small>接下来</small><strong>{status.nextStep.label}</strong><p>{status.nextStep.reason}</p></div>
      <WorkflowPrimaryAction status={status} busy={busy} onAction={onAction} onNotice={onNotice} onOpenWorkflow={onOpenWorkflow} />
    </section>
  );
}
