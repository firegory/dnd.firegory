import ReactMarkdown from "react-markdown";

import "./markdown-text.css";

export function MarkdownText({ content }: { content: string }) {
  return (
    <div className="markdown-text">
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}
