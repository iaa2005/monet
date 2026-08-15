/**
 * In-app documentation — a full-screen overlay with a section sidebar, search,
 * and an on-this-page outline, in the shape of platform.claude.com/docs.
 *
 * Content comes from src/renderer/docs/content as plain Markdown; this file is
 * only the reader. Keeping the two apart is what makes a public site possible
 * later — the same folder can be handed to a static site generator untouched.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X, ChevronRight } from "@/components/icons/hg";
import { cn } from "@/lib/utils";
import { MarkdownViewer } from "@/components/chat/MarkdownViewer";
import {
  ALL_DOC_PAGES,
  DOC_SECTIONS,
  findDocPage,
  searchDocs,
  type DocPage,
} from "@/docs";

/** Headings in the body, for the right-hand outline. */
function outlineOf(body: string): { level: number; text: string; id: string }[] {
  const out: { level: number; text: string; id: string }[] = [];
  // Skip fenced code: a "# comment" inside a shell block is not a heading.
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const text = m[2].replace(/[`*_]/g, "");
    out.push({
      level: m[1].length,
      text,
      id: text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, ""),
    });
  }
  return out;
}

export function DocsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [slug, setSlug] = useState<string>(ALL_DOC_PAGES[0]?.slug ?? "");
  const [query, setQuery] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  const page: DocPage | undefined = useMemo(() => findDocPage(slug), [slug]);
  const results = useMemo(() => (query.trim() ? searchDocs(query) : []), [query]);
  const outline = useMemo(() => (page ? outlineOf(page.body) : []), [page]);

  // Escape closes; a fresh page starts at the top rather than keeping the
  // previous page's scroll position.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [slug]);

  const open = (s: string): void => {
    setSlug(s);
    setQuery("");
  };

  return (
    // Starts below the app's own title bar (h-11): covering it would put this
    // panel on top of the window controls and the drag region.
    <div className="fixed inset-x-0 bottom-0 top-9 z-50 flex flex-col bg-background">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-y border-border px-2">
        {/*<span className="text-sm font-semibold">Code Monet documentation</span>*/}
        <div className="relative w-84">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the docs…"
            className="w-full rounded-md border border-border bg-background py-1.5 pl-7 pr-2 text-sm outline-none focus:ring-1 focus:ring-foreground/20"
          />
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
          aria-label="Close documentation"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
        <nav className="w-64 shrink-0 overflow-y-auto border-r border-border p-3">
          {DOC_SECTIONS.map((section) => (
            <div key={section.id} className="mb-5">
              <div className="mb-1.5 border-b border-border/60 px-2 pb-1.5 text-[10px] font-bold uppercase tracking-[0.09em] text-foreground/50">
                {section.title}
              </div>
              {section.pages.map((p) => (
                <button
                  key={p.slug}
                  type="button"
                  onClick={() => open(p.slug)}
                  className={cn(
                    "block w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    p.slug === slug
                      ? "bg-black/[0.06] font-medium text-foreground dark:bg-white/[0.08]"
                      : "text-muted-foreground hover:bg-black/[0.03] hover:text-foreground dark:hover:bg-white/[0.05]",
                  )}
                >
                  {p.title}
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* Content */}
        <div ref={bodyRef} className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-8 py-8">
            {query.trim() ? (
              <div>
                <h1 className="text-xl font-semibold">
                  {results.length} result{results.length === 1 ? "" : "s"} for “{query}”
                </h1>
                <div className="mt-4 space-y-2">
                  {results.map((r) => (
                    <button
                      key={r.slug}
                      type="button"
                      onClick={() => open(r.slug)}
                      className="flex w-full items-center gap-2 rounded-lg border border-border p-3 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{r.title}</div>
                        {r.description && (
                          <div className="truncate text-xs text-muted-foreground">
                            {r.description}
                          </div>
                        )}
                      </div>
                      <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                  {results.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      Nothing matched. Try a feature name — “memory”, “hooks”,
                      “routines”, “permissions”.
                    </p>
                  )}
                </div>
              </div>
            ) : page ? (
              <article className="docs-body">
                <h1 className="text-2xl font-semibold">{page.title}</h1>
                {page.description && (
                  <p className="mt-1 text-sm text-muted-foreground">{page.description}</p>
                )}
                <div className="mt-6">
                  <MarkdownViewer content={page.body} docsHtml />
                </div>
              </article>
            ) : (
              <p className="text-sm text-muted-foreground">No documentation found.</p>
            )}
          </div>
        </div>

        {/* On this page */}
        {!query.trim() && outline.length > 1 && (
          <aside className="hidden w-56 shrink-0 overflow-y-auto border-l border-border p-4 xl:block">
            <div className="pb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              On this page
            </div>
            {outline.map((h, i) => (
              <a
                key={`${h.id}-${i}`}
                href={`#${h.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  // Headings are rendered by MarkdownViewer without ids, so
                  // match on the text instead of relying on an anchor.
                  const target = [
                    ...(bodyRef.current?.querySelectorAll("h2, h3") ?? []),
                  ].find((el) => el.textContent?.trim() === h.text);
                  target?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className={cn(
                  "block py-1 text-xs text-muted-foreground transition-colors hover:text-foreground",
                  h.level === 3 && "pl-3",
                )}
              >
                {h.text}
              </a>
            ))}
          </aside>
        )}
      </div>
    </div>
  );
}
