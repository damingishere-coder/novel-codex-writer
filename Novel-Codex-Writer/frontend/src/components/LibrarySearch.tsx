import { useEffect, useId, useRef, useState, type Ref } from "react";
import { FileText, LoaderCircle, Search, X } from "lucide-react";
import type { SearchResult } from "../types";

export function LibrarySearch(props: {
  query: string;
  results: SearchResult[];
  status: "idle" | "loading" | "success" | "error";
  error: string;
  enabled: boolean;
  inputRef: Ref<HTMLInputElement>;
  onQuery(value: string): void;
  onSelect(result: SearchResult): void;
  onRetry(): void;
  onMobileOpen(): void;
  onClose(): void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const visible = open;
  const selected = props.status === "success" ? props.results[active] : undefined;
  const mobileOpenRef = useRef(props.onMobileOpen);
  mobileOpenRef.current = props.onMobileOpen;
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  function close() {
    setOpen(false); closeRef.current();
    if (window.innerWidth <= 600 && root.current?.contains(document.activeElement)) document.querySelector<HTMLButtonElement>('[aria-label="搜索资料"]')?.focus();
  }
  function select(result: SearchResult) { props.onSelect(result); close(); }
  useEffect(() => { setActive(0); }, [props.query, props.results]);
  useEffect(() => {
    if (visible && selected) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, visible, selected, listId]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) { setOpen(false); closeRef.current(); }
    };
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !document.querySelector('[role="dialog"]')) {
        event.preventDefault();
        if (window.innerWidth <= 600) mobileOpenRef.current();
        setOpen(true);
        requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
      }
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", shortcut);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", shortcut); };
  }, []);
  const message = !props.enabled ? "请先选择或创建一本作品" : !props.query.trim() ? "输入关键词，搜索当前作品已保存的标题和内容" : props.status === "loading" ? "正在搜索…" : props.status === "error" ? "搜索失败" : props.results.length ? `找到 ${props.results.length === 50 ? "至少 50" : props.results.length} 份文档${props.results.length === 50 ? " · 显示前 50 份" : ""}` : "没有找到匹配内容";
  return <div className="global-search" ref={root} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) close(); }}>
    <Search size={16} aria-hidden="true" />
    <input ref={(element) => { input.current = element; if (typeof props.inputRef === "function") props.inputRef(element); else if (props.inputRef) (props.inputRef as { current: HTMLInputElement | null }).current = element; }}
      role="combobox" aria-label="搜索当前小说资料" aria-autocomplete="list" aria-expanded={visible} aria-controls={visible ? listId : undefined}
      aria-activedescendant={visible && selected ? `${listId}-${active}` : undefined} autoComplete="off" value={props.query}
      onFocus={() => setOpen(true)} onChange={(event) => { setActive(0); props.onQuery(event.target.value); setOpen(true); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); setOpen(true);
          if (props.results.length) setActive((index) => !open ? 0 : (index + (event.key === "ArrowDown" ? 1 : -1) + props.results.length) % props.results.length);
        }
        if (event.key === "Enter" && visible && selected) { event.preventDefault(); select(selected); }
      }} placeholder="搜索当前作品…" />
    {props.query ? <button className="search-clear" aria-label="清空搜索" onMouseDown={(event) => event.preventDefault()} onClick={() => { props.onQuery(""); input.current?.focus(); setOpen(true); }}><X size={14} /></button> : <kbd>Ctrl K</kbd>}
    {visible ? <div className="search-dropdown">
      <div className="search-summary" role="status">{props.status === "loading" && props.query.trim() ? <LoaderCircle size={14} className="animate-spin" /> : null}{message}</div>
      <div className="search-result-list" role="listbox" aria-label="搜索结果" id={listId} aria-busy={props.status === "loading"}>
        {props.status === "success" ? props.results.map((result, index) => <button type="button" role="option" id={`${listId}-${index}`} aria-selected={index === active} tabIndex={-1}
          className="search-result" key={result.path} onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => select(result)}>
          <FileText size={17} aria-hidden="true" /><span><strong><SearchHighlight text={result.title} query={props.query} /></strong><small title={result.path}>{result.groupLabel} · {result.path}</small><span className="search-snippet"><SearchHighlight text={result.snippet} query={props.query} /></span></span>
        </button>) : null}
      </div>
      {props.status === "error" ? <div className="search-empty"><p>{props.error}</p><button className="soft-button" onClick={props.onRetry}>重试搜索</button></div>
        : props.query.trim() && props.status === "success" && !props.results.length ? <p className="search-empty">试试更短的关键词。多个词用空格分开时，需要全部匹配；未保存的草稿不参与搜索。</p> : null}
      <div className="search-help">当前作品 · 已保存资料<span>↑↓ 选择 · Enter 打开 · Esc 关闭</span></div>
    </div> : null}
  </div>;
}

function SearchHighlight({ text, query }: { text: string; query: string }) {
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length).slice(0, 16);
  if (!terms.length) return <>{text}</>;
  const expression = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return <>{text.split(expression).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)}</>;
}
