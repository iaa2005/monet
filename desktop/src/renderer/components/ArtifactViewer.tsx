/**
 * Artifact viewer — a right-side drawer that previews one artifact.
 *
 * Inline preview support:
 *   images     — in-memory dataUrl first (attachments/incognito), then the
 *                on-disk artifact;
 *   pdf        — Chromium's built-in PDF viewer via a blob-URL iframe;
 *   docx       — rendered with docx-preview;
 *   xlsx / xls — sheets rendered as tables via SheetJS;
 *   text/code  — syntax-highlighted source.
 * Anything else offers "Open externally".
 *
 * Controls: refresh, download (save-as), open externally, expand preset,
 * close — plus a draggable left edge for free resizing.
 * Mounted once in App; driven by chatStore.viewerArtifact.
 */

import { useEffect, useRef, useState } from "react";
import {
  Download,
  ExternalLink,
  Maximize2,
  Minimize2,
  RefreshCw,
  X,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import { CodeBlock } from "@/components/chat/CodeBlock";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

function langFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    py: "python",
    js: "javascript",
    mjs: "javascript",
    ts: "typescript",
    tsx: "tsx",
    json: "json",
    csv: "text",
    md: "markdown",
    html: "html",
    css: "css",
    yaml: "yaml",
    yml: "yaml",
    xml: "xml",
    svg: "xml",
    txt: "text",
    tex: "latex",
    bib: "latex",
    sty: "latex",
  };
  return map[ext] ?? "text";
}

const TEXT_EXT =
  /\.(txt|md|csv|tsv|json|jsonc|js|mjs|ts|tsx|py|html|css|xml|svg|yaml|yml|log|tex|bib|sty)$/i;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type PreviewKind = "image" | "pdf" | "docx" | "xlsx" | "text" | "none";

function previewKindOf(item: {
  name: string;
  kind: string;
  dataUrl?: string;
}): PreviewKind {
  const ext = item.name.split(".").pop()?.toLowerCase() ?? "";
  if (item.kind === "image") return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "xlsx" || ext === "xls") return "xlsx";
  if (item.kind === "text" || TEXT_EXT.test(item.name)) return "text";
  return "none";
}

export function ArtifactViewer(): JSX.Element | null {
  const item = useChatStore((s) => s.viewerArtifact);
  const close = useChatStore((s) => s.openArtifactViewer);
  const [width, setWidth] = useState(560);
  const [expanded, setExpanded] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [sheetHtml, setSheetHtml] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const docxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(false);

  const path = item?.path;
  const preview = item ? previewKindOf(item) : "none";

  // Drag-resize on the left edge.
  useEffect(() => {
    const move = (e: PointerEvent): void => {
      if (!dragRef.current) return;
      const w = window.innerWidth - e.clientX;
      setWidth(Math.min(Math.max(w, 380), window.innerWidth - 80));
      setExpanded(false);
    };
    const up = (): void => {
      dragRef.current = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  useEffect(() => {
    setImgUrl(null);
    setSheetHtml(null);
    setText(null);
    setError(null);
    setPdfUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    if (docxRef.current) docxRef.current.innerHTML = "";
    if (!item) return;

    const bridge = api();
    let alive = true;
    const fail = (e: unknown, fallback: string): void => {
      if (alive) setError(e instanceof Error ? e.message : String(e) || fallback);
    };
    const readBytes = async (): Promise<Uint8Array | null> => {
      if (!path) return item.dataUrl ? b64ToBytes(item.dataUrl.split(",")[1] ?? "") : null;
      const r = await bridge?.artifacts.readBytes(path);
      if (!r?.ok || !r.base64) {
        if (alive) setError(r?.error ?? "Can't read file");
        return null;
      }
      return b64ToBytes(r.base64);
    };

    setLoading(true);
    void (async () => {
      try {
        if (preview === "image") {
          // In-memory preview first (attachments / incognito), disk second.
          if (item.dataUrl) {
            if (alive) setImgUrl(item.dataUrl);
          } else if (path) {
            const r = await bridge?.artifacts.readImage(path, item.mediaType);
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
            for (const name of wb.SheetNames.slice(0, 8)) {
              parts.push(
                `<h3 class="sheet-name">${name}</h3>` +
                  XLSX.utils.sheet_to_html(wb.Sheets[name], { header: "", footer: "" }),
              );
            }
            if (alive) setSheetHtml(parts.join("\n"));
          }
        } else if (preview === "text") {
          if (path) {
            const r = await bridge?.artifacts.readText(path);
            if (alive) {
              if (r?.ok) setText(r.content ?? "");
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

  if (!item) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
      <div className="flex-1" onClick={() => close(null)} />
      <div
        className="relative flex h-full flex-col border-l border-border bg-background shadow-2xl"
        style={{ width: expanded ? "min(94vw, 1200px)" : width }}
      >
        {/* Drag handle for free resizing */}
        <div
          className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-link/40"
          onPointerDown={() => {
            dragRef.current = true;
            document.body.style.cursor = "col-resize";
          }}
        />
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border pl-4 pr-2">
          <span
            className="min-w-0 flex-1 truncate text-sm font-medium"
            title={item.name}
          >
            {item.name}
          </span>
          <IconBtn title="Refresh" onClick={() => setNonce((n) => n + 1)}>
            <RefreshCw className="size-4" />
          </IconBtn>
          <IconBtn
            title="Download"
            onClick={() =>
              path && void api()?.artifacts.download(path, item.name)
            }
          >
            <Download className="size-4" />
          </IconBtn>
          <IconBtn
            title="Open externally"
            onClick={() => path && void api()?.artifacts.open(path)}
          >
            <ExternalLink className="size-4" />
          </IconBtn>
          <IconBtn
            title={expanded ? "Shrink" : "Expand"}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <Minimize2 className="size-4" />
            ) : (
              <Maximize2 className="size-4" />
            )}
          </IconBtn>
          <IconBtn title="Close" onClick={() => close(null)}>
            <X className="size-4" />
          </IconBtn>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
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
                alt={item.name}
                className="mx-auto max-w-full rounded-lg border border-border"
              />
            </div>
          )}

          {!error && preview === "pdf" && pdfUrl && (
            <iframe
              src={pdfUrl}
              title={item.name}
              className="h-full w-full border-0"
            />
          )}

          {/* docx-preview renders white pages — keep them on a neutral bed. */}
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

          {!error && preview === "text" && text != null && (
            <div className="p-4">
              <CodeBlock
                code={text}
                language={langFromName(item.name)}
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
                onClick={() => path && void api()?.artifacts.open(path)}
                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
              >
                <ExternalLink className="size-4" />
                Open externally
              </button>
            </div>
          )}
        </div>
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
