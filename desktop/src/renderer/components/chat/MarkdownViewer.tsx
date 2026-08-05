/**
 * Markdown viewer — themed to the Claude palette via react-markdown component
 * overrides (no typography plugin needed).
 */

import type React from "react";
import { memo, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import "katex/dist/katex.min.css";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ui/kbd";
import { CodeBlock } from "./CodeBlock";
import { ArtifactThumb } from "@/components/ArtifactsPanel";
import { viewArtifact } from "@/components/artifact-actions";
import { isWebLink, openLink, wantsExternal } from "@/lib/open-link";
import { splitMarkdownChunks } from "@/lib/markdown-chunks";
import { escapeCurrencyDollars } from "@/lib/currency-dollars";
import { splitFrontmatter } from "@/lib/frontmatter";
import { stripTtsTags } from "@shared/voice-tags";

interface MarkdownViewerProps {
  content: string;
  className?: string;
  /** Documentation pages may use a small set of literal HTML tags (<kbd>).
   * Off for chat: model output stays text, whatever it contains. */
  docsHtml?: boolean;
}

/**
 * The docs pipeline: parse raw HTML, then sanitise it down to GitHub's
 * schema plus <kbd> — so a doc page can draw a keycap, and nothing else
 * changes hands. Chat messages never take this path.
 */
const DOCS_REHYPE = [
  rehypeRaw,
  [
    rehypeSanitize,
    {
      ...defaultSchema,
      tagNames: [...(defaultSchema.tagNames ?? []), "kbd"],
    },
  ],
  rehypeKatex,
] as never[];

function artifactFromPath(path: string, alt: string) {
  const cleanPath = path.replace(/^file:\/\//i, "");
  const name = decodeURIComponent(cleanPath.split(/[\\/]/).pop() ?? alt);
  const mediaType = name.toLowerCase().endsWith(".png")
    ? "image/png"
    : name.toLowerCase().endsWith(".jpg") || name.toLowerCase().endsWith(".jpeg")
      ? "image/jpeg"
      : name.toLowerCase().endsWith(".webp")
        ? "image/webp"
        : "application/octet-stream";
  return { name, path: cleanPath, mediaType, kind: mediaType.startsWith("image/") ? "image" : "file" } as const;
}


/** Flatten a blockquote's children to text, to detect a "[!NOTE]" marker. */
function alertText(children: unknown): string {
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (typeof n === "string") parts.push(n);
    else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === "object" && "props" in n)
      walk((n as { props?: { children?: unknown } }).props?.children);
  };
  walk(children);
  return parts.join("").trim();
}

/** Drop the "[!NOTE]" marker (and the newline after it) from the rendered body. */
function stripAlertMarker(children: unknown): React.ReactNode {
  const strip = (n: unknown): unknown => {
    if (typeof n === "string")
      return n.replace(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/i, "");
    if (Array.isArray(n)) return n.map(strip);
    if (n && typeof n === "object" && "props" in n) {
      const el = n as { props?: { children?: unknown } };
      if (el.props?.children !== undefined)
        return { ...n, props: { ...el.props, children: strip(el.props.children) } };
    }
    return n;
  };
  return strip(children) as React.ReactNode;
}

/**
 * Documents past this size render in pieces (markdown-chunks.ts): the first
 * piece immediately, the rest as the browser goes idle. Measured before it:
 * 137 KB of markdown blocked the main thread for 3.1 seconds, so opening a
 * long .md froze the app outright.
 */
const PROGRESSIVE_THRESHOLD = 40_000;

/**
 * One rendered piece, memoized.
 *
 * Without this, appending piece N re-rendered pieces 1..N-1 as well: the
 * blocking tasks GREW as the document filled in (90ms → 444ms, measured),
 * which is worse than rendering it in one go. Each piece's content never
 * changes once cut, so identity is the whole comparison.
 */
const MarkdownChunk = memo(function MarkdownChunk({
  content,
  components,
  rehype,
}: {
  content: string;
  components: Record<string, unknown>;
  rehype: never[];
}): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={rehype}
      components={components as never}
    >
      {content}
    </ReactMarkdown>
  );
});

function MarkdownViewerImpl({
  content: raw,
  className,
  docsHtml = false,
}: MarkdownViewerProps): JSX.Element {
  // Extract YAML frontmatter so it can be rendered as a code block — but only
  // when it IS frontmatter and not a horizontal rule (see lib/frontmatter).
  const { frontmatter, body } = useMemo(() => {
    const split = splitFrontmatter(raw);
    // Prices are not formulas: "$5 … $10" would otherwise parse as maths and
    // set the sentence between them in KaTeX italics (lib/currency-dollars).
    return {
      frontmatter: split.frontmatter,
      // Spoken-expression tags (<laugh>…) are for the voice, not the eyes.
      body: escapeCurrencyDollars(stripTtsTags(split.body)),
    };
  }, [raw]);

  // Big documents arrive in pieces; small ones stay exactly as they were.
  const chunks = useMemo(
    () =>
      body.length > PROGRESSIVE_THRESHOLD
        ? splitMarkdownChunks(body)
        : [body],
    [body],
  );
  const [shown, setShown] = useState(1);
  useEffect(() => {
    setShown(1);
  }, [chunks]);
  useEffect(() => {
    if (shown >= chunks.length) return;
    // One piece per idle slot: the user reads the top while the tail lands,
    // and no single task is long enough to be felt.
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    if (w.requestIdleCallback) {
      const h = w.requestIdleCallback(() => setShown((n) => n + 1), {
        timeout: 200,
      });
      return () => w.cancelIdleCallback?.(h);
    }
    const t = setTimeout(() => setShown((n) => n + 1), 16);
    return () => clearTimeout(t);
  }, [shown, chunks.length]);

  const components = useMemo(() => ({
    p: ({ node: _n, ...p }: any) => <p className="my-2" {...p} />,
    h1: ({ node: _n, ...p }: any) => <h1 className="mt-5 mb-2 font-semibold" {...p} />,
    h2: ({ node: _n, ...p }: any) => <h2 className="mt-4 mb-2 font-semibold" {...p} />,
    h3: ({ node: _n, ...p }: any) => <h3 className="mt-4 mb-1.5 font-semibold" {...p} />,
    h4: ({ node: _n, ...p }: any) => <h4 className="mt-3 mb-1 font-semibold" {...p} />,
    ul: ({ node: _n, ...p }: any) => <ul className="my-2 list-disc space-y-1 pl-5" {...p} />,
    ol: ({ node: _n, ...p }: any) => <ol className="my-2 list-decimal space-y-1 pl-5" {...p} />,
    li: ({ node: _n, ...p }: any) => <li className="marker:text-foreground" {...p} />,
    a: ({ node: _n, children, ...p }: any) => {
      const href = p.href ?? "";
      const item = href.startsWith("artifacts/") || /^file:\/\//i.test(href)
        ? artifactFromPath(href, String(children ?? ""))
        : undefined;
      if (item) {
        return <button type="button" onClick={() => viewArtifact(item)} className="rounded-[4px] bg-link/10 px-1 py-px font-mono text-[0.9em] text-link hover:bg-link/15">{children}</button>;
      }
      // Not target="_blank": with no window-open handler that gives you a bare
      // Electron window. Plain click opens the Browser panel, where the agent
      // sees the same page you do; Ctrl/Cmd-click hands it to your real browser.
      return (
        <a
          className="font-medium text-link underline underline-offset-2 hover:opacity-80"
          href={href}
          title={
            isWebLink(href)
              ? `${href}\nCtrl+click to open in your browser`
              : href
          }
          onClick={(e) => {
            if (!href) return;
            e.preventDefault();
            openLink(href, { external: wantsExternal(e) });
          }}
        >
          {children}
        </a>
      );
    },
    strong: ({ node: _n, ...p }: any) => <strong className="font-semibold" {...p} />,
    // GitHub-style alerts: "> [!NOTE]" / "> [!WARNING]" etc. render as callout
    // panels. The syntax is deliberately the GitHub one — it survives being
    // published by any static site generator, unlike a custom directive.
    blockquote: ({ node: _n, children, ...p }: any) => {
      const text = alertText(children);
      const kind = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(text)?.[1]?.toUpperCase();
      if (!kind)
        return (
          <blockquote
            className="my-3 border-l-2 border-border pl-3 text-muted-foreground italic"
            {...p}
          >
            {children}
          </blockquote>
        );
      const styles: Record<string, string> = {
        NOTE: "border-sky-500/30 bg-sky-500/10 text-sky-950 dark:text-sky-100",
        TIP: "border-emerald-500/30 bg-emerald-500/10 text-emerald-950 dark:text-emerald-100",
        IMPORTANT: "border-violet-500/30 bg-violet-500/10 text-violet-950 dark:text-violet-100",
        WARNING: "border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-100",
        CAUTION: "border-red-500/30 bg-red-500/10 text-red-950 dark:text-red-100",
      };
      const labels: Record<string, string> = {
        NOTE: "Note",
        TIP: "Tip",
        IMPORTANT: "Important",
        WARNING: "Warning",
        CAUTION: "Caution",
      };
      return (
        <div className={cn("my-4 rounded-lg border px-4 py-3 text-sm", styles[kind])}>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide">
            {labels[kind]}
          </div>
          <div className="[&>p:first-child]:mt-0 [&>p:last-child]:mb-0">
            {stripAlertMarker(children)}
          </div>
        </div>
      );
    },
    hr: ({ node: _n, ...p }: any) => <hr className="my-4 border-border" {...p} />,
    img: ({ node: _n, ...p }: any) => {
      const src = p.src ?? "";
      const alt = p.alt ?? "";
      if (/^(https?:|data:)/i.test(src)) return <img {...p} className="my-2 max-h-[28rem] max-w-full rounded-lg border border-border" />;
      const item = src.startsWith("artifacts/") || /^file:\/\//i.test(src)
        ? artifactFromPath(src, alt)
        : undefined;
      if (item) return item.kind === "image" ? <ArtifactThumb a={item} onClick={() => viewArtifact(item)} className="my-2 max-h-[28rem] max-w-full rounded-lg border border-border object-contain" /> : <button type="button" onClick={() => viewArtifact(item)} className="my-1 inline-flex items-center gap-1 rounded-md bg-link/10 px-1.5 py-0.5 font-mono text-[0.9em] text-link">{item.name}</button>;
      return alt ? <span className="text-[13px] text-muted-foreground italic">[{alt}]</span> : <></>;
    },
    pre: ({ node: _n, children }: any) => <>{children}</>,
    table: ({ node: _n, ...p }: any) => <div className="my-3 overflow-x-auto"><table className="w-full border-separate border-spacing-[3px]" {...p} /></div>,
    th: ({ node: _n, ...p }: any) => <th className="rounded-sm bg-black/[0.04] px-2.5 py-1.5 text-left text-[13px] font-medium text-foreground dark:bg-white/[0.06]" {...p} />,
    td: ({ node: _n, ...p }: any) => <td className="rounded-sm bg-black/[0.04] px-2.5 py-1.5 text-[13px] dark:bg-white/[0.06]" {...p} />,
    code({ className: cls, children, ...props }: any) {
      const { node: _n, ...rest } = props;
      const codeStr = String(children).replace(/\n$/, "");
      const lang = /language-(\w+)/.exec(cls ?? "")?.[1];
      if (lang || codeStr.includes("\n")) return <CodeBlock code={codeStr} language={lang ?? ""} />;
      return <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.9em]" {...rest}>{children}</code>;
    },
    // Only reachable when docsHtml let the tag through the sanitiser.
    kbd: ({ node: _n, ...p }: any) => <Kbd {...p} />,
  }), []);
  const rehype = docsHtml ? DOCS_REHYPE : ([rehypeKatex] as never[]);
  return (
    <div
      className={cn(
        "min-w-0 leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      {frontmatter && (
        <CodeBlock code={frontmatter} language="yaml" className="mb-3" />
      )}
      {chunks.length === 1 ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={rehype}
          components={components}
        >
          {body}
        </ReactMarkdown>
      ) : (
        chunks.slice(0, shown).map((chunk, i) => (
          <MarkdownChunk key={i} content={chunk} components={components} rehype={rehype} />
        ))
      )}
    </div>
  );
}

/**
 * Re-rendering a long document is as expensive as rendering it: measured at
 * 1.7s every time anything in the parent changed, which in the file viewer is
 * every mouse-up. The content is the only input that matters.
 */
export const MarkdownViewer = memo(
  MarkdownViewerImpl,
  (a, b) =>
    a.content === b.content &&
    a.className === b.className &&
    a.docsHtml === b.docsHtml,
);
