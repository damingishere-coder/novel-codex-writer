import {
  Archive,
  Plus,
  BookOpenText,
  ChevronDown,
  ChevronRight,
  Database,
  FileCheck2,
  FileClock,
  FileText,
  FolderKanban,
  ListTree,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  Tag
} from "lucide-react";
import type { DocumentEntry, GroupId, LibraryGroup } from "../types";
import { useEffect, useState } from "react";
import { cn } from "../lib/format";

const groupIcons: Record<GroupId, typeof FileText> = {
  chapters: BookOpenText,
  current: FileClock,
  indexes: Tag,
  archives: Archive,
  outlines: ListTree,
  guides: FileCheck2,
  reviews: FileCheck2,
  commits: FolderKanban,
  memoryPatches: Database,
  snapshots: Database
};

interface LibrarySidebarProps {
  groups: LibraryGroup[];
  selectedPath: string;
  collapsed: boolean;
  openGroups: GroupId[];
  aiConnected: boolean;
  onToggleCollapsed: () => void;
  onToggleGroup: (id: GroupId) => void;
  onSelect: (entry: DocumentEntry) => void;
  onOpenAiSettings: () => void;
  onNewDocument: () => void;
  canCreate: boolean;
}

export function LibrarySidebar(props: LibrarySidebarProps) {
  const order: GroupId[] = ["chapters", "outlines", "current", "archives", "guides", "reviews", "commits", "memoryPatches", "indexes", "snapshots"];
  const visibleGroups = [...props.groups].filter((group) => group.entries.length > 0).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const advanced = visibleGroups.filter((group) => !["chapters", "outlines", "current", "archives"].includes(group.id));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => {
    if (advanced.some((group) => group.entries.some((entry) => entry.path === props.selectedPath))) setAdvancedOpen(true);
  }, [props.selectedPath]);
  function renderGroup(group: LibraryGroup) {
    const open = props.openGroups.includes(group.id);
    const Icon = groupIcons[group.id];
    return <section key={group.id} className="accordion-group">
      <button className="accordion-trigger" onClick={() => props.onToggleGroup(group.id)} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Icon size={16} /><span>{group.label}</span><small>{group.entries.length}</small>
      </button>
      {open ? <div className="accordion-content">{group.entries.map((entry) => <button key={entry.path} className={cn("document-row", entry.path === props.selectedPath && "active")} onClick={() => props.onSelect(entry)} title={entry.path} aria-current={entry.path === props.selectedPath ? "page" : undefined}><span>{entry.title}</span><small>{entry.fileName}</small></button>)}</div> : null}
    </section>;
  }

  if (props.collapsed) {
    return (
      <aside className="library-sidebar collapsed" aria-label="已收起的资料侧栏">
        <button className="icon-button mx-auto" onClick={props.onToggleCollapsed} title="展开资料侧栏">
          <PanelLeftOpen size={17} />
        </button>
        <div className="my-3 h-px bg-[var(--workbench-line)]" />
        {visibleGroups.map((group) => {
          const Icon = groupIcons[group.id];
          const selected = group.entries.some((entry) => entry.path === props.selectedPath);
          return (
            <button
              key={group.id}
              className={cn("rail-button", selected && "active")}
              onClick={() => {
                props.onToggleCollapsed();
                if (!props.openGroups.includes(group.id)) props.onToggleGroup(group.id);
              }}
              title={`${group.label}（${group.entries.length}）`}
            >
              <Icon size={17} />
            </button>
          );
        })}
        <button className="rail-button mt-auto" onClick={props.onOpenAiSettings} title="AI 设置">
          <Settings2 size={17} />
          <span className={cn("status-dot", props.aiConnected && "online")} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="library-sidebar" aria-label="项目资料目录">
      <div className="sidebar-heading">
        <div>
          <p className="eyebrow">WORKSPACE</p>
          <h2>作品资料</h2>
        </div>
        <button className="icon-button" onClick={props.onToggleCollapsed} title="收起资料侧栏">
          <PanelLeftClose size={17} />
        </button>
      </div>

      <div className="sidebar-scroll">
        <nav className="accordion-list" aria-label="作品目录">
          <div className="navigation-section-label"><span>创作</span><button className="text-button" onClick={props.onNewDocument} disabled={!props.canCreate} aria-label="新建文档"><Plus size={14} /></button></div>
          {visibleGroups.filter((group) => ["chapters", "outlines"].includes(group.id)).map(renderGroup)}
          <p className="navigation-section-label">人物与设定资料</p>
          {visibleGroups.filter((group) => ["current", "archives"].includes(group.id)).map(renderGroup)}
          {advanced.length ? <section className="advanced-library"><button className="advanced-trigger" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(!advancedOpen)}>{advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}历史与高级资料</button>{advancedOpen ? advanced.map(renderGroup) : null}</section> : null}
        </nav>
      </div>

      <button className="ai-settings-link" onClick={props.onOpenAiSettings}>
        <Settings2 size={16} />
        <span>
          <strong>AI 设置</strong>
          <small>{props.aiConnected ? "AI 已连接" : "等待配置 AI"}</small>
        </span>
        <span className={cn("status-dot", props.aiConnected && "online")} />
      </button>
    </aside>
  );
}
