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
      className="prose novel-prose max-w-none"
    >
      {stripWebnovelMemoryMetadata(content)}
    </ReactMarkdown>
  );
}
