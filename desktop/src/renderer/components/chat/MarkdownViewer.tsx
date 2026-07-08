/**
 * Markdown viewer — themed to the Claude palette via react-markdown component
 * overrides (no typography plugin needed).
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./CodeBlock";

interface MarkdownViewerProps {
  content: string;
  className?: string;
}

export function MarkdownViewer({
  content,
  className,
}: MarkdownViewerProps): JSX.Element {
  return (
    <div
      className={cn(
        "min-w-0 text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ node: _n, ...p }) => <p className="my-2" {...p} />,
          h1: ({ node: _n, ...p }) => (
            <h1 className="mt-5 mb-2 text-lg font-semibold" {...p} />
          ),
          h2: ({ node: _n, ...p }) => (
            <h2 className="mt-4 mb-2 text-base font-semibold" {...p} />
          ),
          h3: ({ node: _n, ...p }) => (
            <h3 className="mt-4 mb-1.5 text-sm font-semibold" {...p} />
          ),
          ul: ({ node: _n, ...p }) => (
            <ul className="my-2 list-disc space-y-1 pl-5" {...p} />
          ),
          ol: ({ node: _n, ...p }) => (
            <ol className="my-2 list-decimal space-y-1 pl-5" {...p} />
          ),
          li: ({ node: _n, ...p }) => (
            <li className="marker:text-muted-foreground" {...p} />
          ),
          a: ({ node: _n, ...p }) => (
            <a
              className="font-medium text-link underline underline-offset-2 hover:opacity-80"
              target="_blank"
              rel="noreferrer"
              {...p}
            />
          ),
          strong: ({ node: _n, ...p }) => (
            <strong className="font-semibold" {...p} />
          ),
          blockquote: ({ node: _n, ...p }) => (
            <blockquote
              className="my-3 border-l-2 border-border pl-3 text-muted-foreground italic"
              {...p}
            />
          ),
          hr: ({ node: _n, ...p }) => <hr className="my-4 border-border" {...p} />,
          // Unwrap the default <pre> — CodeBlock supplies its own container, so
          // this prevents a nested <pre><pre> for fenced blocks.
          pre: ({ node: _n, children }) => <>{children}</>,
          table: ({ node: _n, ...p }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-xs" {...p} />
            </div>
          ),
          th: ({ node: _n, ...p }) => (
            <th
              className="border border-border bg-muted px-2 py-1 text-left font-medium"
              {...p}
            />
          ),
          td: ({ node: _n, ...p }) => (
            <td className="border border-border px-2 py-1" {...p} />
          ),
          code({ className: cls, children, ...props }) {
            const { node: _n, ...rest } = props as Record<string, unknown>;
            const codeStr = String(children).replace(/\n$/, "");
            // Fenced block: has a language- class, or spans multiple lines.
            const lang = /language-(\w+)/.exec(cls ?? "")?.[1];
            if (lang || codeStr.includes("\n")) {
              return <CodeBlock code={codeStr} language={lang ?? ""} />;
            }
            return (
              <code
                className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em]"
                {...rest}
              >
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
