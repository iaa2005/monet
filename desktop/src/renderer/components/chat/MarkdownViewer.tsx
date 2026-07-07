/**
 * Markdown viewer — lightweight, no heavy syntax highlighter in MVP.
 * Uses basic <pre><code> for code blocks.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownViewerProps {
  content: string;
}

export function MarkdownViewer({ content }: MarkdownViewerProps): JSX.Element {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const { node: _unused, ...rest } = props as Record<string, unknown>;
            const codeStr = String(children).replace(/\n$/, "");

            if (className) {
              return (
                <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
                  <code className={className} {...rest}>
                    {codeStr}
                  </code>
                </pre>
              );
            }

            return (
              <code className="rounded bg-muted px-1 py-0.5 text-xs" {...rest}>
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
