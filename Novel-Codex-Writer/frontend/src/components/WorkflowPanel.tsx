import { CheckCircle2, CircleAlert, Clipboard, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkflowStatus } from "../types";

interface WorkflowPanelProps {
  status?: WorkflowStatus;
  loading: boolean;
  busy: boolean;
  onRefresh: () => void;
  onAction: (action: string, extra?: Record<string, unknown>) => Promise<void>;
  onNotice: (message: string) => void;
}

const statusLabels = {
  missing: "缺失",
  ready: "就绪",
  needs_changes: "需修改",
  stale: "已失效",
  blocked: "阻断",
  finalized: "已最终化"
} as const;

export function WorkflowPanel({ status, loading, busy, onRefresh, onAction, onNotice }: WorkflowPanelProps) {
  const [selectedLegacyPatch, setSelectedLegacyPatch] = useState("");

  useEffect(() => {
    setSelectedLegacyPatch((current) => status?.legacyPatchChoices.includes(current) ? current : "");
  }, [status?.chapter, status?.legacyPatchChoices]);

  async function copyForCodex() {
    if (!status) return;
    const sources = status.reviewContext.map((item) => `- ${item.role}: ${item.path} @ ${item.revision?.slice(0, 12) ?? "missing"}`).join("\n");
    try {
      await navigator.clipboard.writeText(
        `请使用 webnovel-writer Skill 继续第${String(status.chapter).padStart(3, "0")}章。\n当前建议：${status.recommendation}\n上下文清单：\n${sources}`
      );
      onNotice("已复制给 Codex");
    } catch (error) {
      onNotice(error instanceof Error ? `复制失败：${error.message}` : "复制失败：浏览器未授权访问剪贴板");
    }
  }

  if (loading) return <div className="surface-state"><LoaderCircle className="animate-spin" />正在诊断创作进度…</div>;
  if (!status) return <div className="surface-state">尚无工作流状态</div>;
  const patch = status.artifacts.find((item) => item.id === "memoryPatch");

  return (
    <section className="workflow-panel">
      <div className="workflow-heading">
        <div>
          <p className="eyebrow">第{String(status.chapter).padStart(3, "0")}章</p>
          <h2>创作进度</h2>
        </div>
        <button className="icon-button" onClick={onRefresh} disabled={busy} title="重新诊断"><RefreshCw size={16} /></button>
      </div>

      <div className="workflow-steps">
        {status.artifacts.map((artifact) => (
          <div key={artifact.id} className={`workflow-step ${artifact.status}`}>
            {artifact.status === "ready" || artifact.status === "finalized" ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}
            <div>
              <strong>{artifact.label}<small>{statusLabels[artifact.status]}</small></strong>
              <p>{artifact.message}</p>
              {artifact.path ? <code title={artifact.revision}>{artifact.path}</code> : null}
            </div>
          </div>
        ))}
      </div>

      <div className={`workflow-recommendation ${status.state}`}>
        <ShieldCheck size={18} />
        <div><strong>唯一推荐下一步</strong><p>{status.recommendation}</p></div>
      </div>

      {status.legacyPatchChoices.length > 1 ? (
        <div className="workflow-card">
          <strong>确认哪一个旧 patch 是正文结果</strong>
          <select value={selectedLegacyPatch} onChange={(event) => setSelectedLegacyPatch(event.target.value)}>
            <option value="">请选择</option>
            {status.legacyPatchChoices.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
          <button
            className="primary-button"
            disabled={!selectedLegacyPatch || busy}
            onClick={() => onAction("classify_patch", {
              confirmed: true,
              classifications: Object.fromEntries(status.legacyPatchChoices.map((id) => [id, id === selectedLegacyPatch ? "chapter_result" : "outline_baseline"]))
            })}
          >确认分类</button>
        </div>
      ) : null}

      <div className="workflow-actions">
        <button className="soft-button" disabled={busy} onClick={() => onAction("diagnose")}><RefreshCw size={15} />重新诊断</button>
        <button className="soft-button" disabled={busy} onClick={() => onAction("generate_taskbook")}>生成任务书</button>
        <button className="soft-button" disabled={busy || !status.artifacts.some((item) => item.id === "body" && item.status === "ready")} onClick={() => onAction("check_body")}>检查正文</button>
        <button className="soft-button" disabled={busy} onClick={() => onAction("finalization_preflight")}>最终化预检</button>
        {patch?.status === "ready" && patch.path ? (
          <button className="primary-button" disabled={busy} onClick={() => onAction("apply_patch", { patchPath: patch.path, confirmed: true })}>应用已确认 patch</button>
        ) : null}
        <button className="soft-button" disabled={busy} onClick={() => void copyForCodex()}><Clipboard size={15} />复制给 Codex</button>
      </div>

      <details className="workflow-context">
        <summary>本次审阅上下文清单（{status.reviewContext.length}）</summary>
        {status.reviewContext.map((item) => (
          <div key={`${item.role}-${item.path}`} className={item.missing || item.stale ? "context-stale" : ""}>
            <strong>{item.role}</strong><code>{item.path}</code><small>{item.missing ? "缺失" : item.stale ? "revision 已变化" : item.revision?.slice(0, 12)}</small>
          </div>
        ))}
      </details>
    </section>
  );
}
