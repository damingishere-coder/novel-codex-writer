import {
  Archive,
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
import type { DocumentEntry, GroupId, LibraryGroup, SearchResult } from "../types";
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
  query: string;
  searchResults: SearchResult[];
  searchStatus: "idle" | "loading" | "success" | "error";
  searchError: string;
  collapsed: boolean;
  openGroups: GroupId[];
  aiConnected: boolean;
  onToggleCollapsed: () => void;
  onToggleGroup: (id: GroupId) => void;
  onSelect: (entry: DocumentEntry) => void;
  onOpenAiSettings: () => void;
}

export function LibrarySidebar(props: LibrarySidebarProps) {
  const visibleGroups = props.groups.filter((group) => group.entries.length > 0);

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
          <p className="eyebrow">资料库</p>
          <h2>项目目录</h2>
        </div>
        <button className="icon-button" onClick={props.onToggleCollapsed} title="收起资料侧栏">
          <PanelLeftClose size={17} />
        </button>
      </div>

      <div className="sidebar-scroll">
        {props.query.trim() ? (
          <section className="search-results" aria-live="polite">
            <p className="section-caption">
              {props.searchStatus === "success" ? `搜索结果 · ${props.searchResults.length}` : "搜索当前小说资料"}
            </p>
            {props.searchStatus === "loading" ? (
              <p className="empty-caption">正在搜索…</p>
            ) : props.searchStatus === "error" ? (
              <p className="empty-caption search-error">搜索失败：{props.searchError}</p>
            ) : props.searchResults.length ? (
              props.searchResults.map((entry) => (
                <button key={entry.path} className="document-row" onClick={() => props.onSelect(entry)}>
                  <span>{entry.title}</span>
                  <small title={entry.snippet}>{entry.groupLabel} · {entry.snippet}</small>
                </button>
              ))
            ) : props.searchStatus === "success" ? (
              <p className="empty-caption">没有找到匹配内容</p>
            ) : null}
          </section>
        ) : null}

        <nav className="accordion-list">
          {visibleGroups.map((group) => {
            const open = props.openGroups.includes(group.id);
            const Icon = groupIcons[group.id];
            return (
              <section key={group.id} className="accordion-group">
                <button className="accordion-trigger" onClick={() => props.onToggleGroup(group.id)} aria-expanded={open}>
                  {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  <Icon size={15} />
                  <span>{group.label}</span>
                  <small>{group.entries.length}</small>
                </button>
                {open ? (
                  <div className="accordion-content">
                    {group.entries.map((entry) => (
                      <button
                        key={entry.path}
                        className={cn("document-row", entry.path === props.selectedPath && "active")}
                        onClick={() => props.onSelect(entry)}
                        title={entry.path}
                      >
                        <span>{entry.title}</span>
                        <small>{entry.fileName}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
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
