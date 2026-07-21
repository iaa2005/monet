/**
 * Markdown viewer — themed to the Claude palette via react-markdown component
 * overrides (no typography plugin needed).
 */

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./CodeBlock";
import { ArtifactThumb, viewArtifact } from "@/components/ArtifactsPanel";

interface MarkdownViewerProps {
  content: string;
  className?: string;
}

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

export function MarkdownViewer({
  content: raw,
  className,
}: MarkdownViewerProps): JSX.Element {
  // Extract YAML frontmatter so it can be rendered as a code block.
  const { frontmatter, body } = useMemo(() => {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    return m ? { frontmatter: m[1].trimEnd(), body: m[2] } : { frontmatter: null, body: raw };
  }, [raw]);

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
      return <a className="font-medium text-link underline underline-offset-2 hover:opacity-80" target="_blank" rel="noreferrer" href={href}>{children}</a>;
    },
    strong: ({ node: _n, ...p }: any) => <strong className="font-semibold" {...p} />,
    blockquote: ({ node: _n, ...p }: any) => <blockquote className="my-3 border-l-2 border-border pl-3 text-muted-foreground italic" {...p} />,
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
  }), []);
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
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
