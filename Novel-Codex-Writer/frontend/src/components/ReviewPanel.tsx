import { useEffect, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  FileSearch,
  LoaderCircle,
  MapPin,
  PanelRightClose,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  X
} from "lucide-react";
import type { AiEngine, AiStatus, ChapterReviewRun, ReviewAnnotation, ReviewFinding, ReviewSeverity } from "../types";
import { cn } from "../lib/format";

interface ReviewPanelProps {
  annotations: ReviewAnnotation[];
  chapterReview?: ChapterReviewRun;
  isChapter: boolean;
  reviewBusy: boolean;
  reviewMessage?: string;
  selectedId?: string;
  aiStatus?: AiStatus;
  onSelect: (id: string) => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onUpdate: (id: string, patch: Partial<ReviewAnnotation>) => void;
  onCallAi: (id: string) => void;
  onAccept: (id: string) => void;
  onIgnore: (id: string) => void;
  onRegenerate: (id: string) => void;
  onDelete: (id: string) => void;
  onProcessAll: () => void;
  onRunChapterReview: (engine: AiEngine) => void;
  onAcceptFinding: (id: string) => void;
  onDismissFinding: (id: string) => void;
  onLocateFinding: (id: string) => void;
  onExport: () => void;
}

const severityLabels: Record<ReviewSeverity, string> = {
  S1: "硬性失败",
  S2: "必须修改",
  S3: "建议修改",
  S4: "轻微润色"
};

const categoryLabels: Record<ReviewFinding["category"], string> = {
  chapter_format: "章节规范",
  outline: "任务完成度",
  continuity: "承接一致性",
  character: "人物",
  timeline: "时间线",
  world: "设定",
  foreshadowing: "伏笔",
  pacing: "节奏",
  voice: "文风",
  repetition: "重复",
  language: "语言"
};

export function ReviewPanel(props: ReviewPanelProps) {
  const [engine, setEngine] = useState<AiEngine>(props.aiStatus?.settings.engine ?? "deepseek");
  const [severity, setSeverity] = useState<"all" | ReviewSeverity>("all");
  useEffect(() => setEngine(props.aiStatus?.settings.engine ?? "deepseek"), [props.aiStatus?.settings.engine]);

  const pending = props.annotations.filter((item) => ["draft", "pending", "ready", "error", "stale"].includes(item.status)).length;
  const findings = props.chapterReview?.findings ?? [];
  const visibleFindings = severity === "all" ? findings : findings.filter((item) => item.severity === severity);
  const canExport = Boolean(props.annotations.length || props.chapterReview);

  return (
    <aside id="review-panel" className="review-panel" aria-label="AI 审阅与批注">
      <div className="review-heading">
        <div><p className="eyebrow">写作助手</p><h2>AI 审阅</h2></div>
        <div className="flex gap-1">
          <button className="icon-button" onClick={props.onOpenSettings} title="AI 设置"><Settings2 size={16} /></button>
          <button className="icon-button" onClick={props.onClose} title="隐藏审阅栏"><PanelRightClose size={17} /></button>
        </div>
      </div>

      {props.isChapter ? (
        <div className="chapter-review-controls">
          <select value={engine} onChange={(event) => setEngine(event.target.value as AiEngine)} aria-label="整章体检引擎">
            <option value="deepseek">DeepSeek V4</option>
            <option value="codex">Codex</option>
          </select>
          <button className="primary-button" onClick={() => props.onRunChapterReview(engine)} disabled={props.reviewBusy}>
            {props.reviewBusy ? <LoaderCircle size={15} className="animate-spin" /> : <FileSearch size={15} />}
            {props.reviewBusy ? "体检中" : "整章体检"}
          </button>
          {props.reviewMessage ? <p className="chapter-review-progress">{props.reviewMessage}</p> : null}
        </div>
      ) : (
        <p className="chapter-review-unavailable">整章体检仅对“正文”文档开放。</p>
      )}

      {props.chapterReview ? <ReviewSummary run={props.chapterReview} /> : null}

      <div className="review-actions">
        <button className="soft-button" onClick={props.onProcessAll} disabled={!pending}><Sparkles size={14} />处理划线批注</button>
        <button className="icon-button" onClick={props.onExport} title="导出审阅报告" disabled={!canExport}><Download size={15} /></button>
      </div>

      {findings.length ? (
        <div className="review-severity-tabs" aria-label="问题级别筛选">
          {(["all", "S1", "S2", "S3", "S4"] as const).map((item) => (
            <button key={item} className={severity === item ? "active" : ""} onClick={() => setSeverity(item)}>
              {item === "all" ? "全部" : item}<b>{item === "all" ? findings.length : findings.filter((finding) => finding.severity === item).length}</b>
            </button>
          ))}
        </div>
      ) : null}

      <div className="review-scroll">
        {props.chapterReview?.contextManifest.length ? (
          <details className="context-manifest">
            <summary>本次送审资料（{props.chapterReview.contextManifest.length}）</summary>
            <ul>{props.chapterReview.contextManifest.map((item, index) => <li key={`${item.path}-${index}`} className={item.missing ? "missing" : ""}><strong>{item.role}</strong><span>{item.path}</span><small>{item.missing ? "缺失" : `${item.characters} 字符${item.truncated ? " · 已截取" : ""}`}</small></li>)}</ul>
          </details>
        ) : null}

        {visibleFindings.map((finding) => (
          <FindingCard
            key={finding.id}
            finding={finding}
            selected={props.selectedId === finding.id}
            onSelect={() => props.onSelect(finding.id)}
            onAccept={() => props.onAcceptFinding(finding.id)}
            onDismiss={() => props.onDismissFinding(finding.id)}
            onLocate={() => props.onLocateFinding(finding.id)}
          />
        ))}

        {props.annotations.length ? <h3 className="review-section-title">划线精修（{props.annotations.length}）</h3> : null}
        {props.annotations.map((annotation) => (
          <AnnotationCard
            key={annotation.id}
            annotation={annotation}
            selected={props.selectedId === annotation.id}
            aiStatus={props.aiStatus}
            onSelect={() => props.onSelect(annotation.id)}
            onUpdate={(patch) => props.onUpdate(annotation.id, patch)}
            onCallAi={() => props.onCallAi(annotation.id)}
            onAccept={() => props.onAccept(annotation.id)}
            onIgnore={() => props.onIgnore(annotation.id)}
            onRegenerate={() => props.onRegenerate(annotation.id)}
            onDelete={() => props.onDelete(annotation.id)}
          />
        ))}

        {!visibleFindings.length && !props.annotations.length ? (
          <div className="review-empty"><Sparkles size={24} /><strong>{props.chapterReview ? "本次未发现需要报告的问题" : props.isChapter ? "可以先运行一次整章体检" : "点击左侧行号添加批注"}</strong><p>{props.chapterReview ? "如继续修改草稿，结果会自动标记为过期；重新体检后才能恢复通过。" : "划线精修只改选中原文；整章体检会先做免费本地检查，再调用所选 AI。"}</p></div>
        ) : null}
      </div>
    </aside>
  );
}

function ReviewSummary({ run }: { run: ChapterReviewRun }) {
  const blocking = run.findings.filter((item) => (item.severity === "S1" || item.severity === "S2") && (item.status === "open" || item.status === "stale")).length;
  const label = run.status === "running" ? "审阅中" : run.status === "error" ? "AI 未完成" : run.status === "stale" ? "结果已过期" : run.verdict === "pass" ? "审查通过" : "需要修改";
  return <div className={cn("chapter-review-summary", `is-${run.status}`, run.verdict === "pass" && "is-pass")}>
    {run.verdict === "pass" && run.status === "completed" ? <ShieldCheck size={18} /> : <CircleAlert size={18} />}
    <div><strong>{label}</strong><p>{run.summary}</p><small>{run.engine} · {run.findings.length} 项 · {blocking} 项阻塞</small></div>
  </div>;
}

function FindingCard({ finding, selected, onSelect, onAccept, onDismiss, onLocate }: {
  finding: ReviewFinding;
  selected: boolean;
  onSelect: () => void;
  onAccept: () => void;
  onDismiss: () => void;
  onLocate: () => void;
}) {
  const actionable = finding.status === "open" && Boolean(finding.after && finding.before && finding.fromLine && finding.toLine);
  return <article className={cn("finding-card", `severity-${finding.severity.toLowerCase()}`, selected && "selected", `is-${finding.status}`)} onClick={onSelect}>
    <header><span className="severity-badge" title={severityLabels[finding.severity]}>{finding.severity}</span><strong>{finding.title}</strong><span className="finding-category">{categoryLabels[finding.category]}</span></header>
    <p className="finding-evidence">{finding.evidence}</p>
    {finding.before ? <blockquote>{finding.before}</blockquote> : null}
    <dl><div><dt>影响</dt><dd>{finding.impact}</dd></div><div><dt>修法</dt><dd>{finding.fixSuggestion}</dd></div></dl>
    {finding.after ? <div className="finding-replacement"><strong>建议替换为</strong><p>{finding.after}</p></div> : null}
    {finding.sourceRefs.length ? <details className="finding-sources"><summary>核查来源（{finding.sourceRefs.length}）</summary>{finding.sourceRefs.map((source) => <p key={source.path}><strong>{source.path}</strong><span>{source.snippet}</span></p>)}</details> : null}
    {finding.dismissalReason ? <p className="finding-dismissal">不适用理由：{finding.dismissalReason}</p> : null}
    <footer onClick={(event) => event.stopPropagation()}>
      {finding.fromLine ? <button className="soft-button" onClick={onLocate}><MapPin size={14} />定位原文</button> : null}
      {actionable ? <button className="primary-button" onClick={onAccept}><Check size={14} />采用</button> : null}
      {finding.status === "open" || finding.status === "stale" ? <button className="soft-button" onClick={onDismiss}><X size={14} />标记不适用</button> : <span className="finding-status">{finding.status === "accepted" ? "已采用" : "已标记不适用"}</span>}
    </footer>
  </article>;
}

function AnnotationCard({ annotation, selected, aiStatus, onSelect, onUpdate, onCallAi, onAccept, onIgnore, onRegenerate, onDelete }: {
  annotation: ReviewAnnotation;
  selected: boolean;
  aiStatus?: AiStatus;
  onSelect: () => void;
  onUpdate: (patch: Partial<ReviewAnnotation>) => void;
  onCallAi: () => void;
  onAccept: () => void;
  onIgnore: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
}) {
  const engineReady = annotation.engine === "deepseek" ? aiStatus?.deepseek.available : aiStatus?.codex.available;
  const status = getStatus(annotation);
  const isRunning = annotation.status === "running";
  const closed = annotation.status === "accepted" || annotation.status === "ignored";
  const messages = annotation.messages ?? [];
  const hasConversation = messages.length > 0;
  const hasAssistantReply = messages.some((message) => message.role === "assistant");
  const keep = annotation.suggestion?.decision === "keep";
  return <article className={cn("annotation-card", status.tone, selected && "selected")} onClick={onSelect}>
    <header><span className="status-icon">{status.icon}</span><strong>第 {annotation.fromLine === annotation.toLine ? annotation.fromLine : `${annotation.fromLine}-${annotation.toLine}`} 行</strong><span>{status.label}</span><ChevronDown size={15} className="ml-auto" /><button className="annotation-delete" onClick={(event) => { event.stopPropagation(); onDelete(); }} title="删除批注"><Trash2 size={13} /></button></header>
    <section className="annotation-source"><h3>原文</h3><p className="quoted-text">{annotation.originalText}</p></section>

    {hasConversation ? (
      <section className="annotation-conversation" aria-label="批注对话记录">
        <h3>对话</h3>
        <div className="conversation-list">
          {messages.map((message) => (
            <div key={message.id} className={cn("conversation-message", `is-${message.role}`)}>
              <div className="conversation-avatar">{message.role === "user" ? <UserRound size={13} /> : <Bot size={14} />}</div>
              <div className="conversation-body">
                <div className="conversation-meta"><strong>{message.role === "user" ? "你" : "AI 审阅"}</strong>{message.engine ? <span>{message.engine === "deepseek" ? "DeepSeek V4" : "Codex"}</span> : null}</div>
                <p className="conversation-text">{message.content}</p>
                {message.suggestion ? (
                  <div className={cn("suggestion-preview", message.suggestion.decision === "keep" && "is-keep")}>
                    <div className="suggestion-label"><Check size={13} /><strong>{message.suggestion.decision === "keep" ? "建议保留原文" : "可替换文本"}</strong><span>{message.suggestion.severity} · {categoryLabels[message.suggestion.category]}</span></div>
                    {message.suggestion.decision === "change" ? <p className="suggested-text">{message.suggestion.after}</p> : null}
                    <p className="suggestion-rationale">{message.suggestion.rationale}</p>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          {isRunning ? <div className="conversation-message is-assistant is-typing"><div className="conversation-avatar"><Bot size={14} /></div><div className="conversation-body"><LoaderCircle size={14} className="animate-spin" /><span>正在结合上下文思考…</span></div></div> : null}
        </div>
      </section>
    ) : null}

    {annotation.error ? <p className="annotation-error"><CircleAlert size={14} />{annotation.error}</p> : null}
    {!closed ? (
      <>
        {hasConversation ? <div className="response-actions" onClick={(event) => event.stopPropagation()}>
          {annotation.suggestion && !keep ? <button className="primary-button" onClick={onAccept} disabled={annotation.status === "stale" || isRunning}><Check size={14} />采用这版</button> : null}
          <button className="soft-button" onClick={onIgnore} disabled={isRunning}><X size={14} />{keep ? "接受保留" : "结束本轮"}</button>
        </div> : null}
        <section className="followup-composer" onClick={(event) => event.stopPropagation()}>
          <div className="composer-heading"><div><h3>{hasConversation ? "继续追问" : "你的问题"}</h3><small>{hasConversation ? "AI 会记住上面的对话" : "可以润色、起名、解释或列出多个方案"}</small></div>{hasAssistantReply || annotation.status === "error" ? <button className="text-button" onClick={onRegenerate} disabled={isRunning}><RefreshCw size={13} />{annotation.status === "error" ? "重试上一问" : "换个回答"}</button> : null}</div>
          <textarea
            value={annotation.comment}
            onChange={(event) => onUpdate({
              comment: event.target.value,
              ...(annotation.status === "error" ? { status: "draft", error: undefined } : {})
            })}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && annotation.comment.trim() && !isRunning) {
                event.preventDefault();
                onCallAi();
              }
            }}
            placeholder={hasConversation ? "继续追问，或换一种要求重新提问…" : "例如：这本法典叫什么名字？请给我 5 个候选"}
            rows={3}
          />
          <div className="composer-footer">
            <label className="engine-select"><span>引擎</span><select value={annotation.engine} onChange={(event) => onUpdate({ engine: event.target.value as AiEngine })} disabled={isRunning}><option value="deepseek">DeepSeek V4 · 快速</option><option value="codex">Codex · 深度</option></select></label>
            <span className="composer-shortcut">Ctrl Enter</span>
            <button className="primary-button" onClick={onCallAi} disabled={isRunning || !annotation.comment.trim()}>{isRunning ? <LoaderCircle size={15} className="animate-spin" /> : <Send size={15} />}{isRunning ? "回答中" : hasConversation ? "发送追问" : "调用 AI"}</button>
            {!engineReady ? <small className="engine-warning">当前引擎尚未连接；调用后会显示具体原因</small> : null}
          </div>
        </section>
      </>
    ) : <div className="annotation-closed-note">{annotation.status === "accepted" ? <><Check size={15} />已应用到草稿；如需继续修改，请再次点击左侧行号。</> : <><X size={15} />本轮对话已结束；如需重新提问，请再次点击左侧行号。</>}</div>}
  </article>;
}

function getStatus(annotation: ReviewAnnotation) {
  if (annotation.status === "running") return { label: "分析中", tone: "is-running", icon: <LoaderCircle size={14} className="animate-spin" /> };
  if (annotation.status === "accepted") return { label: "已采用", tone: "is-accepted", icon: <Check size={14} /> };
  if (annotation.status === "ignored") return { label: "已忽略", tone: "is-ignored", icon: <X size={14} /> };
  if (annotation.status === "stale") return { label: "需重新分析", tone: "is-stale", icon: <CircleAlert size={14} /> };
  if (annotation.status === "error") return { label: "调用失败", tone: "is-error", icon: <CircleAlert size={14} /> };
  if (annotation.status === "ready") return { label: annotation.suggestion ? "待确认" : "可继续追问", tone: "is-ready", icon: <Sparkles size={14} /> };
  return { label: "待补充", tone: "is-draft", icon: <Sparkles size={14} /> };
}
