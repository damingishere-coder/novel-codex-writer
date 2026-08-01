import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { stripWebnovelMemoryMetadata } from "../lib/format";

interface MarkdownViewProps {
  content: string;
}

export function MarkdownView({ content }: MarkdownViewProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      className="prose prose-zinc max-w-none font-serif prose-headings:font-sans prose-headings:font-semibold prose-h1:text-3xl prose-h2:mt-10 prose-h2:border-b prose-h2:border-line prose-h2:pb-2 prose-p:leading-8 prose-li:my-1 prose-table:font-sans prose-th:bg-zinc-100 prose-th:p-3 prose-td:p-3 prose-code:rounded prose-code:bg-zinc-100 prose-code:px-1.5 prose-code:py-0.5 prose-code:text-cinnabar prose-pre:bg-zinc-950 dark:prose-invert dark:prose-th:bg-zinc-800 dark:prose-code:bg-zinc-800"
    >
      {stripWebnovelMemoryMetadata(content)}
    </ReactMarkdown>
  );
}
