import { ArchiveRestore, Download, FileClock, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
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
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (!props.projectId) return;
    setBusy(true);
    try {
      const [versionPayload, trashPayload] = await Promise.all([
        props.document ? fetchVersions(props.projectId, props.document.path) : Promise.resolve(undefined),
        fetchTrash(props.projectId)
      ]);
      setVersions(versionPayload);
      setTrash(trashPayload.entries);
    } catch (error) {
      props.onNotice(error instanceof Error ? error.message : "恢复资料读取失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void refresh(); }, [props.projectId, props.document?.path, props.document?.revision]);

  return (
    <section className="workflow-panel recovery-panel">
      <div className="workflow-heading">
        <div><p className="eyebrow">安全恢复</p><h2>版本与回收站</h2></div>
        <button className="icon-button" onClick={() => void refresh()} disabled={busy}><RefreshCw size={16} /></button>
      </div>
      {busy ? <div className="surface-state"><LoaderCircle className="animate-spin" />正在读取…</div> : null}

      <div className="workflow-card">
        <strong><FileClock size={16} />当前文档历史</strong>
        {!versions?.versions.length ? <p>还没有历史版本；首次实际修改保存后会出现。</p> : versions.versions.map((version) => (
          <div className="recovery-row" key={version.id}>
            <span>{new Date(version.createdAt).toLocaleString("zh-CN")}<small>{version.revision.slice(0, 12)}</small></span>
            <button onClick={async () => setDiff(await fetchVersionDiff(props.projectId, props.document!.path, version.id))}>差异</button>
            <button onClick={async () => {
              if (!props.document || !window.confirm("恢复会把当前正文保存进历史，再创建一个恢复后的当前版本。继续吗？")) return;
              try {
                const restored = await restoreVersion(props.projectId, props.document.path, version.id, props.document.revision);
                props.onDocumentRestored(restored);
                props.onNotice("历史版本已恢复；原当前版本仍保留在历史中。");
              } catch (error) { props.onNotice(error instanceof Error ? error.message : "恢复失败"); }
            }}>恢复</button>
          </div>
        ))}
      </div>

      {diff ? <div className="workflow-card diff-preview"><strong>从第 {diff.fromLine} 行开始的差异</strong><p>历史版本</p><pre>{diff.before || "（无）"}</pre><p>当前版本</p><pre>{diff.after || "（无）"}</pre></div> : null}

      <div className="workflow-card">
        <strong><ArchiveRestore size={16} />回收站</strong>
        {!trash.length ? <p>回收站为空。</p> : trash.map((entry) => (
          <div className="recovery-row" key={entry.id}>
            <span>{entry.path}<small>{new Date(entry.deletedAt).toLocaleString("zh-CN")}</small></span>
            <button onClick={async () => {
              try {
                await restoreTrash(props.projectId, entry.id);
                await props.onLibraryChanged();
                await refresh();
                props.onNotice(`已恢复：${entry.path}`);
              } catch (error) { props.onNotice(error instanceof Error ? error.message : "恢复失败"); }
            }}>恢复</button>
          </div>
        ))}
      </div>

      <div className="workflow-card">
        <strong><Download size={16} />导出</strong>
        <div className="workflow-actions">
          <button className="soft-button" onClick={async () => {
            const result = await exportBook(props.projectId, "markdown");
            props.onNotice(`整书 Markdown 已导出：${result.path}${result.missingChapters?.length ? `（缺 ${result.missingChapters.length} 章）` : ""}`);
          }}>整书 Markdown</button>
          <button className="primary-button" onClick={async () => {
            const result = await exportBook(props.projectId, "zip");
            props.onNotice(`完整 ZIP 备份已导出：${result.path}`);
          }}>完整 ZIP 备份</button>
        </div>
      </div>
    </section>
  );
}
