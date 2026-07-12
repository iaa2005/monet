/**
 * FileViewer — a unified file preview card.
 *
 * Two entry points:
 *   - `path`  — reads the file via `api().files.read` (text / markdown source);
 *   - `item`  — a rich artifact (`{ name, path?, mediaType, kind, dataUrl? }`)
 *               from chatStore.viewerArtifact. Previews images (via dataUrl /
 *               artifacts.readImage), pdf (blob-URL iframe), docx (docx-preview),
 *               xlsx/xls (SheetJS), and text/code (syntax-highlighted).
 *
 * Always rendered as a self-contained card (`rounded-xl border border-border`).
 * In artifact mode, extra controls (refresh / download / open-externally /
 * expand) are shown alongside the close button.
 */

import { useEffect, useRef, useState } from "react";
import {
  Download,
  ExternalLink,
  FileText,
  Maximize2,
  Minimize2,
  RefreshCw,
  X,
} from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  oneLight,
  oneDark,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { MarkdownViewer } from "./chat/MarkdownViewer";
import { CodeBlock } from "./chat/CodeBlock";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/** Public shape for artifacts passed from chatStore.viewerArtifact. */
export type FileViewerItem = {
  name: string;
  path?: string;
  mediaType: string;
  kind: string;
  dataUrl?: string;
};

// --- Language detection ---

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  css: "css",
  scss: "scss",
  less: "less",
  html: "markup",
  xml: "markup",
  svg: "markup",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  sql: "sql",
  tex: "latex",
  bib: "latex",
  sty: "latex",
};

function langFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? "text";
}

// --- Rich (artifact) preview helpers ---

const TEXT_EXT =
  /\.(txt|md|csv|tsv|json|jsonc|js|mjs|ts|tsx|py|html|css|xml|svg|yaml|yml|log|tex|bib|sty)$/i;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type PreviewKind = "image" | "pdf" | "docx" | "xlsx" | "text" | "none";

function previewKindOf(item: FileViewerItem): PreviewKind {
  const ext = item.name.split(".").pop()?.toLowerCase() ?? "";
  if (item.kind === "image") return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "xlsx" || ext === "xls") return "xlsx";
  if (item.kind === "text" || TEXT_EXT.test(item.name)) return "text";
  return "none";
}

// --- Component ---

export function FileViewer({
  path,
  item,
  onClose,
}: {
  path?: string | null;
  item?: FileViewerItem | null;
  onClose: () => void;
}): JSX.Element {
  // --- Plain-file state ---
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // --- Artifact state ---
  const [expanded, setExpanded] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [sheetHtml, setSheetHtml] = useState<string | null>(null);
  const [artText, setArtText] = useState<string | null>(null);
  const docxRef = useRef<HTMLDivElement>(null);

  const isArtifact = !!item;
  const displayName = item?.name ?? (path ? path.split(/[/\\]/).pop() || path : "");
  const isMd = /\.(md|markdown)$/i.test(displayName);
  const dark = document.documentElement.classList.contains("dark");
  const preview: PreviewKind = item ? previewKindOf(item) : "none";

  // --- Load plain file content ---
  useEffect(() => {
    if (isArtifact || !path) return;
    let cancelled = false;
    setLoading(true);
    setContent(null);
    setError(null);
    api()
      ?.files.read(path)
      .then((c) => {
        if (!cancelled)
          setContent(c.length > 400000 ? c.slice(0, 400000) + "\n\n… (truncated)" : c);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, isArtifact]);

  // --- Load rich preview ---
  const artPath = item?.path;

  useEffect(() => {
    if (!item) return;
    setImgUrl(null);
    setSheetHtml(null);
    setArtText(null);
    setError(null);
    setLoading(true);
    setPdfUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    if (docxRef.current) docxRef.current.innerHTML = "";

    const bridge = api();
    let alive = true;
    const fail = (e: unknown, fallback: string): void => {
      if (alive) setError(e instanceof Error ? e.message : String(e) || fallback);
    };
    const readBytes = async (): Promise<Uint8Array | null> => {
      if (!artPath)
        return item.dataUrl ? b64ToBytes(item.dataUrl.split(",")[1] ?? "") : null;
      const r = await bridge?.artifacts.readBytes(artPath);
      if (!r?.ok || !r.base64) {
        if (alive) setError(r?.error ?? "Can't read file");
        return null;
      }
      return b64ToBytes(r.base64);
    };

    void (async () => {
      try {
        if (preview === "image") {
          if (item.dataUrl) {
            if (alive) setImgUrl(item.dataUrl);
          } else if (artPath) {
            const r = await bridge?.artifacts.readImage(artPath, item.mediaType);
            if (alive) {
              if (r?.ok && r.dataUrl) setImgUrl(r.dataUrl);
              else setError(r?.error ?? "Can't read image");
            }
          } else {
            if (alive) setError("No preview data for this image.");
          }
        } else if (preview === "pdf") {
          const bytes = await readBytes();
          if (bytes && alive) {
            const url = URL.createObjectURL(
              new Blob([bytes as BlobPart], { type: "application/pdf" }),
            );
            setPdfUrl(url);
          }
        } else if (preview === "docx") {
          const bytes = await readBytes();
          if (bytes && alive && docxRef.current) {
            const { renderAsync } = await import("docx-preview");
            await renderAsync(bytes.buffer, docxRef.current, undefined, {
              ignoreWidth: false,
              inWrapper: true,
            });
          }
        } else if (preview === "xlsx") {
          const bytes = await readBytes();
          if (bytes && alive) {
            const XLSX = await import("xlsx");
            const wb = XLSX.read(bytes, { type: "array" });
            const parts: string[] = [];
            for (const sheetName of wb.SheetNames.slice(0, 8)) {
              parts.push(
                `<h3 class="sheet-name">${sheetName}</h3>` +
                  XLSX.utils.sheet_to_html(wb.Sheets[sheetName], { header: "", footer: "" }),
              );
            }
            if (alive) setSheetHtml(parts.join("\n"));
          }
        } else if (preview === "text") {
          if (artPath) {
            const r = await bridge?.artifacts.readText(artPath);
            if (alive) {
              if (r?.ok) setArtText(r.content ?? "");
              else setError(r?.error ?? "Can't read file");
            }
          } else if (alive) {
            setError("No preview data for this file.");
          }
        }
      } catch (e) {
        fail(e, "Preview failed");
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.path, item?.name, item?.dataUrl, nonce]);

  // Revoke the blob URL when it changes/unmounts.
  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium" title={item?.path ?? path ?? ""}>
            {displayName}
          </span>
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {isArtifact && (
            <>
              <IconBtn title="Refresh" onClick={() => setNonce((n) => n + 1)}>
                <RefreshCw className="size-3.5" />
              </IconBtn>
              <IconBtn
                title="Download"
                onClick={() => artPath && void api()?.artifacts.download(artPath, displayName)}
              >
                <Download className="size-3.5" />
              </IconBtn>
              <IconBtn
                title="Open externally"
                onClick={() => artPath && void api()?.artifacts.open(artPath)}
              >
                <ExternalLink className="size-3.5" />
              </IconBtn>
              <IconBtn title={expanded ? "Shrink" : "Expand"} onClick={() => setExpanded((v) => !v)}>
                {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              </IconBtn>
            </>
          )}
          <IconBtn title="Close" onClick={onClose}>
            <X className="size-3.5" />
          </IconBtn>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {isArtifact ? (
          <>
            {loading && (
              <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            )}
            {error && (
              <div className="m-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            {!error && preview === "image" && imgUrl && (
              <div className="p-4">
                <img
                  src={imgUrl}
                  alt={displayName}
                  className="mx-auto max-w-full rounded-lg border border-border"
                />
              </div>
            )}

            {!error && preview === "pdf" && pdfUrl && (
              <iframe
                src={pdfUrl}
                title={displayName}
                className="h-full w-full border-0"
              />
            )}

            {/* docx-preview renders white pages on a neutral bed. */}
            <div
              ref={docxRef}
              className={
                preview === "docx" && !error
                  ? "docx-host min-h-0 bg-black/[0.04] p-3 dark:bg-white/[0.06] [&_.docx-wrapper]:bg-transparent [&_.docx-wrapper]:p-0 [&_section.docx]:mx-auto [&_section.docx]:mb-3 [&_section.docx]:shadow"
                  : "hidden"
              }
            />

            {!error && preview === "xlsx" && sheetHtml && (
              <div
                className="p-4 text-[13px] [&_.sheet-name]:mb-1 [&_.sheet-name]:mt-4 [&_.sheet-name]:font-semibold [&_.sheet-name]:first:mt-0 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1"
                dangerouslySetInnerHTML={{ __html: sheetHtml }}
              />
            )}

            {!error && preview === "text" && artText != null && (
              <div className="p-4">
                <CodeBlock
                  code={artText}
                  language={langFor(displayName)}
                  className="my-0"
                />
              </div>
            )}

            {!loading && !error && preview === "none" && (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  No inline preview for this file type.
                </p>
                <button
                  type="button"
                  onClick={() => artPath && void api()?.artifacts.open(artPath)}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                >
                  <ExternalLink className="size-4" />
                  Open externally
                </button>
              </div>
            )}
          </>
        ) : error ? (
          <div className="p-4 text-sm text-destructive">{error}</div>
        ) : content == null ? (
          <div className="p-4 text-sm text-muted-foreground">Loading…</div>
        ) : isMd ? (
          <div className="mx-auto max-w-3xl p-6">
            <MarkdownViewer content={content} />
          </div>
        ) : (
          <SyntaxHighlighter
            language={langFor(displayName)}
            style={dark ? oneDark : oneLight}
            showLineNumbers
            wrapLongLines={false}
            customStyle={{
              margin: 0,
              padding: "1rem",
              background: "transparent",
              fontSize: "12.5px",
              lineHeight: "1.6",
            }}
            codeTagProps={{
              style: { fontFamily: "var(--font-mono)", background: "transparent" },
            }}
          >
            {content}
          </SyntaxHighlighter>
        )}
      </div>
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
    >
      {children}
    </button>
  );
}
