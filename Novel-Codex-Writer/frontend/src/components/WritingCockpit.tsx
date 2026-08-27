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
  if (loading) return <section className="writing-cockpit is-loading"><LoaderCircle className="animate-spin" size={17} />正在判断唯一下一步…</section>;
  if (!status) return <section className="writing-cockpit is-blocked"><CircleAlert size={17} />暂时无法读取创作进度，请打开流程面板重新诊断。</section>;
  const completed = status.artifacts.filter((item) => item.status === "ready" || item.status === "finalized").length;
  return (
    <section className={`writing-cockpit state-${status.state}`} aria-label="下一章写作驾驶舱">
      <div className="cockpit-summary">
        <p className="eyebrow">{project.name} · 第{String(status.chapter).padStart(3, "0")}章</p>
        <strong>创作进度 {completed}/6</strong>
        <div className="cockpit-progress" aria-label={`六步进度 ${completed}/6`}><span style={{ width: `${completed / 6 * 100}%` }} /></div>
      </div>
      <div className="cockpit-reason"><small>唯一下一步</small><strong>{status.nextStep.label}</strong><p>{status.nextStep.reason}</p></div>
      <WorkflowPrimaryAction status={status} busy={busy} onAction={onAction} onNotice={onNotice} onOpenWorkflow={onOpenWorkflow} />
    </section>
  );
}
