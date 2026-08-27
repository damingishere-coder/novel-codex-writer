import { BookOpen, Filter, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fetchMemoryOverview, fetchProjectConsistency } from "../lib/api";
import type { MemoryOverview, ProjectConsistencyReport } from "../types";

const categoryLabels: Record<string, string> = {
  character: "人物",
  relationship: "关系",
  foreshadowing: "伏笔",
  timeline: "时间线",
  fact: "不可违背事实",
  location: "地点",
  setting: "设定",
  workflow: "流程约束"
};

function categoryLabel(value: string) {
  return categoryLabels[value.toLowerCase()] ?? value;
}

export function MemoryPanel({ projectId, onOpenSource, onNotice }: {
  projectId: string;
  onOpenSource(path: string, line: number): void;
  onNotice(message: string): void;
}) {
  const [overview, setOverview] = useState<MemoryOverview>();
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [chapter, setChapter] = useState("");
  const [query, setQuery] = useState("");
  const [consistency, setConsistency] = useState<ProjectConsistencyReport>();

  async function load(signal?: AbortSignal) {
    if (!projectId) return;
    setLoading(true);
    try {
      setOverview(await fetchMemoryOverview(projectId, signal));
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      onNotice(caught instanceof Error ? caught.message : "连续性索引读取失败");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    setOverview(undefined);
    setCategory("");
    setStatus("");
    setChapter("");
    setQuery("");
    setConsistency(undefined);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [projectId]);

  const categories = useMemo(() => [...new Set(overview?.records.map((item) => item.category) ?? [])].sort(), [overview]);
  const statuses = useMemo(() => [...new Set(overview?.records.map((item) => item.status) ?? [])].sort(), [overview]);
  const records = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return (overview?.records ?? []).filter((item) => {
      if (category && item.category !== category) return false;
      if (status && item.status !== status) return false;
      if (chapter && item.sourceChapter !== Number(chapter)) return false;
      if (!normalized) return true;
      return [item.title, item.status, ...item.entities, ...item.tags].some((value) => value.toLocaleLowerCase().includes(normalized));
    });
  }, [overview, category, status, chapter, query]);
  const groupedRecords = useMemo(() => {
    const grouped = new Map<string, typeof records>();
    for (const record of records) grouped.set(record.category, [...(grouped.get(record.category) ?? []), record]);
    return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right, "zh-CN"));
  }, [records]);

  if (loading && !overview) return <div className="surface-state"><LoaderCircle className="animate-spin" />正在读取连续性索引…</div>;
  return (
    <section className="memory-panel">
      <div className="workflow-heading">
        <div><p className="eyebrow">只读索引</p><h2>连续性浏览器</h2></div>
        <button className="icon-button" onClick={() => void load()} disabled={loading} title="刷新索引"><RefreshCw size={16} /></button>
      </div>
      <div className="consistency-card">
        <button className="soft-button" disabled={loading} onClick={async () => {
          setLoading(true);
          try { setConsistency(await fetchProjectConsistency(projectId)); }
          catch (caught) { onNotice(caught instanceof Error ? caught.message : "一致性检查失败"); }
          finally { setLoading(false); }
        }}>运行只读项目一致性检查</button>
        {consistency ? <p className={`consistency-result ${consistency.status}`}>已检查 {consistency.checkedFiles} 个文件：{consistency.status === "ready" ? "未发现问题" : `发现 ${consistency.issues.length} 个问题`}</p> : null}
        {consistency?.issues.map((issue, index) => <div key={`${issue.code}-${index}`} className={`memory-diagnostic ${issue.severity}`}><TriangleAlert size={15} /><span>{issue.message}{issue.path ? <code>{issue.path}</code> : null}</span></div>)}
      </div>
      {overview?.diagnostics.map((diagnostic) => (
        <div key={diagnostic.code} className={`memory-diagnostic ${diagnostic.severity}`}><TriangleAlert size={15} /><span>{diagnostic.message}</span></div>
      ))}
      <div className="memory-filters">
        <label><Filter size={14} /><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">全部分类</option>{categories.map((item) => <option key={item} value={item}>{categoryLabel(item)}</option>)}</select></label>
        <select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option>{statuses.map((item) => <option key={item} value={item}>{item}</option>)}</select>
        <input type="number" min="1" value={chapter} onChange={(event) => setChapter(event.target.value)} placeholder="来源章节" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选实体或标签" />
      </div>
      {!overview || overview.indexStatus === "missing" ? <p className="empty-copy">还没有可浏览的记忆索引。完成并应用一章 memory patch 后会自动建立。</p> : null}
      <div className="memory-records">
        {groupedRecords.map(([group, items]) => (
          <section key={group} className="memory-category"><h3>{categoryLabel(group)}<small>{items.length}</small></h3>{items.map((item) => (
            <article key={item.id} className="memory-record">
              <header><strong>{item.title}</strong><small>{item.status}</small></header>
              <p>{item.entities.join(" · ") || "未标注实体"}</p>
              <div className="memory-tags">{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
              <dl>
                <div><dt>来源章节</dt><dd>{item.sourceChapter ? `第${item.sourceChapter}章` : "未标注"}</dd></div>
                <div><dt>有效范围</dt><dd>{item.validFrom ?? "?"} – {item.validTo ?? "当前"}</dd></div>
                <div><dt>最后 patch</dt><dd>{item.updatedByPatch ?? "未标注"}</dd></div>
              </dl>
              <button className="soft-button" onClick={() => onOpenSource(item.source, item.line)}><BookOpen size={14} />打开来源 · 第 {item.line} 行</button>
            </article>
          ))}</section>
        ))}
      </div>
      {overview && overview.indexStatus !== "missing" && !records.length ? <p className="empty-copy">当前筛选没有匹配记录。</p> : null}
    </section>
  );
}
