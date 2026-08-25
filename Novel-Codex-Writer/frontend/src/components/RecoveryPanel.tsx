import { ArchiveRestore, Download, FileClock, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  exportBook,
  fetchTrash,
  fetchVersionDiff,
  fetchVersions,
  restoreTrash,
  restoreVersion
} from "../lib/api";
import type { DocumentResponse, TrashEntry, VersionDiff, VersionsResponse } from "../types";

interface RecoveryPanelProps {
  projectId: string;
  document?: DocumentResponse;
  onDocumentRestored: (document: DocumentResponse) => void;
  onLibraryChanged: () => Promise<void>;
  onNotice: (message: string) => void;
}

export function RecoveryPanel(props: RecoveryPanelProps) {
  const [versions, setVersions] = useState<VersionsResponse>();
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [diff, setDiff] = useState<VersionDiff>();
  const [refreshing, setRefreshing] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const refreshIdRef = useRef(0);
  const refreshAbortRef = useRef<AbortController>();
  const actionBusyRef = useRef(false);
  const documentKeyRef = useRef("");
  documentKeyRef.current = `${props.projectId}:${props.document?.path ?? ""}:${props.document?.revision ?? ""}`;

  async function runAction(action: () => Promise<void>) {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true;
    setActionBusy(true);
    try {
      await action();
    } catch (error) {
      props.onNotice(error instanceof Error ? error.message : "操作失败");
    } finally {
      actionBusyRef.current = false;
      setActionBusy(false);
    }
  }

  async function refresh() {
    if (!props.projectId) return;
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    const refreshId = ++refreshIdRef.current;
    setRefreshing(true);
    try {
      const [versionPayload, trashPayload] = await Promise.all([
        props.document ? fetchVersions(props.projectId, props.document.path, controller.signal) : Promise.resolve(undefined),
        fetchTrash(props.projectId, controller.signal)
      ]);
      if (refreshId === refreshIdRef.current) {
        setVersions(versionPayload);
        setTrash(trashPayload.entries);
      }
    } catch (error) {
      if (!controller.signal.aborted && refreshId === refreshIdRef.current) {
        props.onNotice(error instanceof Error ? error.message : "恢复资料读取失败");
      }
    } finally {
      if (refreshId === refreshIdRef.current) setRefreshing(false);
    }
  }

  useEffect(() => {
    setDiff(undefined);
    setVersions(undefined);
    setTrash([]);
    void refresh();
    return () => {
      refreshAbortRef.current?.abort();
      refreshIdRef.current += 1;
    };
  }, [props.projectId, props.document?.path, props.document?.revision]);

  const busy = refreshing || actionBusy;

  return (
    <section className="workflow-panel recovery-panel">
      <div className="workflow-heading">
        <div><p className="eyebrow">安全恢复</p><h2>版本与回收站</h2></div>
        <button className="icon-button" onClick={() => void refresh()} disabled={busy} title="刷新版本与回收站" aria-label="刷新版本与回收站"><RefreshCw size={16} /></button>
      </div>
      {busy ? <div className="surface-state"><LoaderCircle className="animate-spin" />正在读取…</div> : null}

      <div className="workflow-card">
        <strong><FileClock size={16} />当前文档历史</strong>
        {!versions?.versions.length ? <p>还没有历史版本；首次实际修改保存后会出现。</p> : versions.versions.map((version) => (
          <div className="recovery-row" key={version.id}>
            <span>{new Date(version.createdAt).toLocaleString("zh-CN")}<small>{version.revision.slice(0, 12)}</small></span>
            <button disabled={busy || !props.document} onClick={() => void runAction(async () => {
              if (!props.document) return;
              const documentKey = documentKeyRef.current;
              const nextDiff = await fetchVersionDiff(props.projectId, props.document.path, version.id);
              if (documentKey === documentKeyRef.current) setDiff(nextDiff);
            })}>差异</button>
            <button disabled={busy} onClick={() => void runAction(async () => {
              if (!props.document || !window.confirm("恢复会把当前正文保存进历史，再创建一个恢复后的当前版本。继续吗？")) return;
              const documentKey = documentKeyRef.current;
              const restored = await restoreVersion(props.projectId, props.document.path, version.id, props.document.revision);
              if (documentKey === documentKeyRef.current) {
                props.onDocumentRestored(restored);
                props.onNotice("历史版本已恢复；原当前版本仍保留在历史中。");
              }
            })}>恢复</button>
          </div>
        ))}
      </div>

      {diff ? <div className="workflow-card diff-preview"><strong>从第 {diff.fromLine} 行开始的差异</strong><p>历史版本</p><pre>{diff.before || "（无）"}</pre><p>当前版本</p><pre>{diff.after || "（无）"}</pre></div> : null}

      <div className="workflow-card">
        <strong><ArchiveRestore size={16} />回收站</strong>
        {!trash.length ? <p>回收站为空。</p> : trash.map((entry) => (
          <div className="recovery-row" key={entry.id}>
            <span>{entry.path}<small>{new Date(entry.deletedAt).toLocaleString("zh-CN")}</small></span>
            <button disabled={busy} onClick={() => void runAction(async () => {
              const result = await restoreTrash(props.projectId, entry.id);
              await props.onLibraryChanged();
              await refresh();
              props.onNotice(result.recoveryArchived
                ? `已恢复：${entry.path}`
                : `已恢复：${entry.path}；为避免并发路径替换造成丢失，原回收站副本仍保留。`);
            })}>恢复</button>
          </div>
        ))}
      </div>

      <div className="workflow-card">
        <strong><Download size={16} />导出</strong>
        <div className="workflow-actions">
          <button className="soft-button" disabled={busy} onClick={() => void runAction(async () => {
            const result = await exportBook(props.projectId, "markdown");
            props.onNotice(`整书 Markdown 已导出：${result.path}${result.missingChapters?.length ? `（缺 ${result.missingChapters.length} 章）` : ""}`);
          })}>整书 Markdown</button>
          <button className="primary-button" disabled={busy} onClick={() => void runAction(async () => {
            const result = await exportBook(props.projectId, "zip");
            props.onNotice(`完整 ZIP 备份已导出：${result.path}`);
          })}>完整 ZIP 备份</button>
        </div>
      </div>
    </section>
  );
}
