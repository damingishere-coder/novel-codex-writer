import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibrarySearch } from "./LibrarySearch";
import type { SearchResult } from "../types";

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useId: () => "search-test",
  useState: (initial: unknown) => [typeof initial === "boolean" ? true : initial, vi.fn()],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: vi.fn()
}));
afterEach(() => vi.unstubAllGlobals());

function setup(patch: Partial<Parameters<typeof LibrarySearch>[0]> = {}) {
  vi.stubGlobal("window", { innerWidth: 1440 });
  const result = { path: "正文/第一章.md", title: "旧信 [a+b]", groupLabel: "章节正文", snippet: "正文里有 [a+b] 和 <script>，不执行标签。" } as SearchResult;
  const props = {
    query: "[a+b]", results: [result], status: "success" as const, error: "", enabled: true,
    inputRef: vi.fn(), onQuery: vi.fn(), onSelect: vi.fn(), onRetry: vi.fn(), onMobileOpen: vi.fn(), onClose: vi.fn(), ...patch
  };
  const tree = LibrarySearch(props);
  function nodes(node: ReactNode): ReactElement<Record<string, any>>[] {
    return Children.toArray(node).flatMap((child) => isValidElement<Record<string, any>>(child) ? [child, ...nodes(child.props.children)] : []);
  }
  return { props, tree, nodes: nodes(tree), result };
}

describe("search dropdown boundaries", () => {
  it("renders counts, snippets and literal query highlighting without treating content as HTML or regex", () => {
    const { tree } = setup();
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("找到 1 份文档");
    expect(html).toContain("<mark>[a+b]</mark>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-activedescendant="search-test-0"');
  });

  it("keeps empty, loading, error and capped counts explicit", () => {
    for (const [patch, text] of [
      [{ results: [] }, "没有找到匹配内容"],
      [{ status: "loading", results: [] }, "正在搜索"],
      [{ status: "error", error: "网络失败", results: [] }, "重试搜索"],
      [{ enabled: false, results: [] }, "请先选择"],
      [{ query: "", results: [] }, "输入关键词"]
    ] as const) expect(renderToStaticMarkup(setup(patch as any).tree)).toContain(text);
    const { result } = setup();
    expect(renderToStaticMarkup(setup({ results: Array.from({ length: 50 }, (_, index) => ({ ...result, path: String(index) })) }).tree)).toContain("至少 50");
  });

  it("opens only a selected completed result, ignores IME Enter and closes on Escape", () => {
    const { props, nodes, result } = setup();
    const input = nodes.find((node) => node.type === "input")!;
    const key = (value: string, composing = false) => ({ key: value, nativeEvent: { isComposing: composing }, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    input.props.onKeyDown(key("Enter", true));
    expect(props.onSelect).not.toHaveBeenCalled();
    input.props.onKeyDown(key("ArrowDown"));
    input.props.onKeyDown(key("ArrowUp"));
    input.props.onKeyDown(key("Enter"));
    expect(props.onSelect).toHaveBeenCalledWith(result);
    input.props.onKeyDown(key("Escape"));
    expect(props.onClose).toHaveBeenCalled();
    const pending = setup({ results: [], status: "loading" });
    pending.nodes.find((node) => node.type === "input")!.props.onKeyDown(key("Enter"));
    expect(pending.props.onSelect).not.toHaveBeenCalled();
  });

  it("routes clicking, clearing, retry and query changes through the existing actions", () => {
    const { props, nodes, result } = setup();
    nodes.find((node) => node.props.role === "option")!.props.onClick();
    expect(props.onSelect).toHaveBeenCalledWith(result);
    nodes.find((node) => node.props["aria-label"] === "清空搜索")!.props.onClick();
    expect(props.onQuery).toHaveBeenCalledWith("");
    nodes.find((node) => node.type === "input")!.props.onChange({ target: { value: "新的词" } });
    expect(props.onQuery).toHaveBeenCalledWith("新的词");
    const failed = setup({ status: "error", results: [] });
    failed.nodes.find((node) => node.props.children === "重试搜索")!.props.onClick();
    expect(failed.props.onRetry).toHaveBeenCalled();
  });
});
