/**
 * Markdown viewer — themed to the Claude palette via react-markdown component
 * overrides (no typography plugin needed).
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
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
        "min-w-0 leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          p: ({ node: _n, ...p }) => <p className="my-2" {...p} />,
          h1: ({ node: _n, ...p }) => (
            <h1 className="mt-5 mb-2 font-semibold" {...p} />
          ),
          h2: ({ node: _n, ...p }) => (
            <h2 className="mt-4 mb-2 font-semibold" {...p} />
          ),
          h3: ({ node: _n, ...p }) => (
            <h3 className="mt-4 mb-1.5 font-semibold" {...p} />
          ),
          h4: ({ node: _n, ...p }) => (
            <h4 className="mt-3 mb-1 font-semibold" {...p} />
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
          a: ({ node: _n, children, ...p }) => {
            const href = (p as { href?: string }).href ?? "";
            const isFile =
              /\.(ts|tsx|js|jsx|py|rb|go|rs|java|kt|css|scss|html|json|yaml|yml|md|sh|ps1|sql|svg|txt|toml|dockerfile|makefile|c|h|cpp|hpp|cs|php|swift)(\b|$)/i.test(
                href,
              );
            return (
              <a
                className={cn(
                  "font-medium underline underline-offset-2 hover:opacity-80",
                  isFile
                    ? "rounded-[4px] bg-link/10 px-1 py-px font-mono text-[0.9em] text-link no-underline hover:bg-link/15"
                    : "text-link",
                )}
                target="_blank"
                rel="noreferrer"
                {...p}
              >
                {children}
              </a>
            );
          },
          strong: ({ node: _n, ...p }) => (
            <strong className="font-semibold" {...p} />
          ),
          blockquote: ({ node: _n, ...p }) => (
            <blockquote
              className="my-3 border-l-2 border-border pl-3 text-muted-foreground italic"
              {...p}
            />
          ),
          hr: ({ node: _n, ...p }) => (
            <hr className="my-4 border-border" {...p} />
          ),
          // Unwrap the default <pre> — CodeBlock supplies its own container, so
          // this prevents a nested <pre><pre> for fenced blocks.
          pre: ({ node: _n, children }) => <>{children}</>,
          table: ({ node: _n, ...p }) => (
            <div className="my-3 overflow-x-auto">
              <table
                className="w-full border-separate border-spacing-[3px]"
                {...p}
              />
            </div>
          ),
          th: ({ node: _n, ...p }) => (
            <th
              className="rounded-sm bg-black/[0.04] px-2.5 py-1.5 text-left text-[13px] font-medium text-foreground dark:bg-white/[0.06]"
              {...p}
            />
          ),
          td: ({ node: _n, ...p }) => (
            <td
              className="rounded-sm bg-black/[0.04] px-2.5 py-1.5 text-[13px] dark:bg-white/[0.06]"
              {...p}
            />
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
                className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.9em]"
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
