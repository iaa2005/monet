/**
 * FileViewer — a unified file preview card.
 *
 * Two entry points, ONE pipeline:
 *   - `item`  — a rich artifact (`{ name, path?, mediaType, kind, dataUrl? }`)
 *               from chatStore.viewer;
 *   - `path`  — any file from the file trees. Known binary types (images, pdf,
 *               docx, xlsx, audio, video) are synthesized into the same rich
 *               item shape and previewed identically — never dumped as text;
 *               everything else renders as text/markdown/code.
 *
 * Reads go through artifacts:* for artifacts (their readers are locked to the
 * artifacts dir) and files:* for tree paths. Always rendered as a
 * self-contained card (`rounded-xl border border-border`) with refresh /
 * download / open-externally controls in both modes.
 */

import { useEffect, useRef, useState } from "react";
import {
  Download,
  ExternalLink,
  FileText,
  RefreshCw,
  X,
} from "lucide-react";
import { MarkdownViewer } from "./chat/MarkdownViewer";
import { HighlightedCode } from "./chat/highlight";
import { CodeEditor } from "./CodeEditor";
import { codeRef, selectionLineRange } from "@/lib/refs";
import { useChatStore } from "@/stores/chatStore";
import { MessageSquarePlus } from "lucide-react";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/** Public shape for artifacts passed from chatStore.viewer. */
export type FileViewerItem = {
  name: string;
  path?: string;
  mediaType: string;
  kind: string;
  dataUrl?: string;
  /** Where reads go: chat artifact (default) or an arbitrary file on disk. */
  source?: "artifact" | "file";
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

// --- Rich preview detection ---

const TEXT_EXT =
  /\.(txt|md|csv|tsv|json|jsonc|js|mjs|ts|tsx|py|html|css|xml|svg|yaml|yml|log|tex|bib|sty)$/i;
const MAX_TEXT_PREVIEW_CHARS = 400_000;
const MAX_XLSX_ROWS = 500;
const MAX_XLSX_CELLS = 20_000;

function truncateText(text: string): string {
  return text.length > MAX_TEXT_PREVIEW_CHARS
    ? text.slice(0, MAX_TEXT_PREVIEW_CHARS) + "\n\n… (truncated)"
    : text;
}

type PreviewKind =
  | "image"
  | "pdf"
  | "docx"
  | "xlsx"
  | "audio"
  | "video"
  | "text"
  | "none";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};
const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac",
};
const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
};
/** Known-binary extensions with no inline preview — show the fallback card
 * instead of dumping bytes as text. */
const OPAQUE_EXT = new Set([
  "zip", "7z", "rar", "tar", "gz", "bz2", "xz",
  "exe", "dll", "so", "dylib", "bin", "dat", "db", "sqlite", "wasm",
  "o", "obj", "lib", "a", "class", "pyc", "pyd", "node", "iso", "msi",
  "ttf", "otf", "woff", "woff2", "doc", "ppt", "pptx",
]);

function extOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/** Rich preview kind for a plain filename, or null → render as text/code. */
function richKindForName(name: string): PreviewKind | null {
  const ext = extOf(name);
  if (IMAGE_MIME[ext]) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "xlsx" || ext === "xls") return "xlsx";
  if (AUDIO_MIME[ext]) return "audio";
  if (VIDEO_MIME[ext]) return "video";
  if (OPAQUE_EXT.has(ext)) return "none";
  return null;
}

function mediaTypeForName(name: string): string {
  const ext = extOf(name);
  return (
    IMAGE_MIME[ext] ??
    AUDIO_MIME[ext] ??
    VIDEO_MIME[ext] ??
    (ext === "pdf" ? "application/pdf" : "application/octet-stream")
  );
}

function previewKindOf(item: FileViewerItem): PreviewKind {
  const ext = extOf(item.name);
  if (item.kind === "image") return "image";
  if (item.kind === "audio" || AUDIO_MIME[ext]) return "audio";
  if (item.kind === "video" || VIDEO_MIME[ext]) return "video";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "xlsx" || ext === "xls") return "xlsx";
  if (item.kind === "text" || TEXT_EXT.test(item.name)) return "text";
  return "none";
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
  // A tree file with a known binary type becomes a synthesized rich item and
  // flows through the SAME preview pipeline as artifacts.
  const displayName =
    item?.name ?? (path ? path.split(/[/\\]/).pop() || path : "");
  const treeRichKind = !item && path ? richKindForName(displayName) : null;
  const eff: FileViewerItem | null =
    item ??
    (path && treeRichKind
      ? {
          name: displayName,
          path,
          mediaType: mediaTypeForName(displayName),
          kind: treeRichKind === "image" ? "image" : "file",
          source: "file",
        }
      : null);
  const source: "artifact" | "file" = eff?.source ?? (item ? "artifact" : "file");
  const isRich = !!eff;
  const filePath = eff?.path ?? path ?? null;

  // --- Plain-file state ---
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // --- Rich state ---
  const [nonce, setNonce] = useState(0);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [sheetHtml, setSheetHtml] = useState<string | null>(null);
  const [artText, setArtText] = useState<string | null>(null);
  const docxRef = useRef<HTMLDivElement>(null);

  const isMd = /\.(md|markdown)$/i.test(displayName);

  // ── Select code → chip in the composer ─────────────────────────────
  // Selecting lines in the code view offers "Add to chat": the selection
  // becomes a ⟨file:lines⟩ chip in the composer and a <referenced-code>
  // block for the model — the same pipeline as the browser's element picks.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [codeSel, setCodeSel] = useState<{
    start: number;
    end: number;
    x: number;
    y: number;
  } | null>(null);

  const onBodyMouseUp = (): void => {
    const sel = window.getSelection();
    const host = bodyRef.current;
    const range = host ? selectionLineRange(host, sel) : null;
    if (!sel || !host || !range) {
      setCodeSel(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    setCodeSel({
      ...range,
      // Content coordinates, so the button scrolls with the selection.
      x: rect.left - hostRect.left + host.scrollLeft,
      y: rect.bottom - hostRect.top + host.scrollTop + 6,
    });
  };

  const addSelectionToChat = (): void => {
    if (!codeSel) return;
    const text = content ?? artText ?? "";
    const snippet = text
      .split("\n")
      .slice(codeSel.start - 1, codeSel.end)
      .join("\n");
    useChatStore.getState().addPendingContext(
      codeRef({
        path: filePath ?? displayName,
        name: displayName,
        startLine: codeSel.start,
        endLine: codeSel.end,
        snippet,
      }),
    );
    setCodeSel(null);
    window.getSelection()?.removeAllRanges();
    window.dispatchEvent(new CustomEvent("monet:focus-composer"));
  };
  const preview: PreviewKind = eff ? previewKindOf(eff) : "none";

  // --- Load plain file content (text/markdown/code) ---
  useEffect(() => {
    if (isRich || !path) return;
    let cancelled = false;
    setLoading(true);
    setContent(null);
    setError(null);
    api()
      ?.files.read(path)
      .then((c) => {
        if (!cancelled)
          setContent(truncateText(c));
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
  }, [path, isRich, nonce]);

  // --- Load rich preview ---
  const effPath = eff?.path;

  useEffect(() => {
    if (!eff) return;
    setImgUrl(null);
    setSheetHtml(null);
    setArtText(null);
    setError(null);
    setLoading(true);
    setBlobUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    if (docxRef.current) docxRef.current.innerHTML = "";

    const bridge = api();
    let alive = true;
    const fail = (e: unknown, fallback: string): void => {
      if (alive) setError(e instanceof Error ? e.message : String(e) || fallback);
    };
    const readB64 = async (): Promise<string | null> => {
      if (!effPath)
        return eff.dataUrl ? (eff.dataUrl.split(",")[1] ?? "") : null;
      const r =
        source === "file"
          ? await bridge?.files.readBytes(effPath)
          : await bridge?.artifacts.readBytes(effPath);
      if (!r?.ok || !r.base64) {
        if (alive) setError(r?.error ?? "Can't read file");
        return null;
      }
      return r.base64;
    };
    const makeBlobUrl = async (mime: string): Promise<void> => {
      const b64 = await readB64();
      if (b64 && alive) {
        const url = URL.createObjectURL(
          new Blob([b64ToBytes(b64) as BlobPart], { type: mime }),
        );
        setBlobUrl(url);
      }
    };

    void (async () => {
      try {
        if (preview === "image") {
          if (eff.dataUrl) {
            if (alive) setImgUrl(eff.dataUrl);
          } else if (effPath && source === "artifact") {
            const r = await bridge?.artifacts.readImage(effPath, eff.mediaType);
            if (alive) {
              if (r?.ok && r.dataUrl) setImgUrl(r.dataUrl);
              else setError(r?.error ?? "Can't read image");
            }
          } else if (effPath) {
            const b64 = await readB64();
            if (b64 && alive) setImgUrl(`data:${eff.mediaType};base64,${b64}`);
          } else {
            if (alive) setError("No preview data for this image.");
          }
        } else if (preview === "pdf") {
          await makeBlobUrl("application/pdf");
        } else if (preview === "audio" || preview === "video") {
          await makeBlobUrl(eff.mediaType);
        } else if (preview === "docx") {
          const b64 = await readB64();
          if (b64 && alive && docxRef.current) {
            const { renderAsync } = await import("docx-preview");
            await renderAsync(b64ToBytes(b64).buffer, docxRef.current, undefined, {
              ignoreWidth: false,
              inWrapper: true,
            });
          }
        } else if (preview === "xlsx") {
          const b64 = await readB64();
          if (b64 && alive) {
            const XLSX = await import("xlsx");
            const wb = XLSX.read(b64ToBytes(b64), { type: "array" });
            const parts: string[] = [];
            for (const sheetName of wb.SheetNames.slice(0, 8)) {
              const sheet = wb.Sheets[sheetName];
              const sourceRange = sheet["!ref"]
                ? XLSX.utils.decode_range(sheet["!ref"])
                : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
              const sourceRows = sourceRange.e.r - sourceRange.s.r + 1;
              const sourceCols = sourceRange.e.c - sourceRange.s.c + 1;
              const rows = Math.min(sourceRows, MAX_XLSX_ROWS);
              const cols = Math.min(
                sourceCols,
                Math.max(1, Math.floor(MAX_XLSX_CELLS / rows)),
              );
              const range = {
                s: sourceRange.s,
                e: {
                  r: sourceRange.s.r + rows - 1,
                  c: sourceRange.s.c + cols - 1,
                },
              };
              const truncated = rows < sourceRows || cols < sourceCols;
              const previewSheet = {
                ...sheet,
                "!ref": XLSX.utils.encode_range(range),
              };
              parts.push(
                `<h3 class="sheet-name">${sheetName}</h3>` +
                  XLSX.utils.sheet_to_html(previewSheet, { header: "", footer: "" }) +
                  (truncated
                    ? `<p class="sheet-truncated">… preview capped at ${rows} rows / ${rows * cols} cells</p>`
                    : ""),
              );
            }
            if (alive) setSheetHtml(parts.join("\n"));
          }
        } else if (preview === "text") {
          if (effPath && source === "artifact") {
            const r = await bridge?.artifacts.readText(effPath);
            if (alive) {
              if (r?.ok) setArtText(truncateText(r.content ?? ""));
              else setError(r?.error ?? "Can't read file");
            }
          } else if (effPath) {
            const c = await bridge?.files.read(effPath);
            if (alive) setArtText(truncateText(c ?? ""));
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
  }, [eff?.path, eff?.name, eff?.dataUrl, nonce]);

  // Revoke the blob URL when it changes/unmounts.
  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  const download = (): void => {
    if (!filePath) return;
    if (source === "artifact")
      void api()?.artifacts.download(filePath, displayName);
    else void api()?.files.saveAs(filePath, displayName);
  };
  const openExternal = (): void => {
    if (!filePath) return;
    if (source === "artifact") void api()?.artifacts.open(filePath);
    else void api()?.shell.openPath(filePath);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Actions only: the dock tab already names the file and closes it. */}
      <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border px-2 py-1">
        <IconBtn title="Refresh" onClick={() => setNonce((n) => n + 1)}>
          <RefreshCw className="size-3.5" />
        </IconBtn>
        {filePath && (
          <>
            <IconBtn title="Download" onClick={download}>
              <Download className="size-3.5" />
            </IconBtn>
            <IconBtn title="Open externally" onClick={openExternal}>
              <ExternalLink className="size-3.5" />
            </IconBtn>
          </>
        )}
      </div>

      {/* Body */}
      <div
        ref={bodyRef}
        onMouseUp={onBodyMouseUp}
        className="relative min-h-0 flex-1 overflow-auto"
      >
        {codeSel ? (
          <button
            type="button"
            onClick={addSelectionToChat}
            title={`Add lines ${codeSel.start}–${codeSel.end} to the chat`}
            style={{ left: codeSel.x, top: codeSel.y }}
            className="absolute z-10 flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs shadow-md hover:bg-muted"
          >
            <MessageSquarePlus className="size-3.5 text-brand" />
            Add to chat
            <span className="text-muted-foreground">
              {displayName}:{codeSel.start}
              {codeSel.end > codeSel.start ? `–${codeSel.end}` : ""}
            </span>
          </button>
        ) : null}
        {isRich ? (
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

            {!error && preview === "pdf" && blobUrl && (
              <iframe
                src={blobUrl}
                title={displayName}
                className="h-full w-full border-0"
              />
            )}

            {!error && preview === "audio" && blobUrl && (
              <div className="p-4">
                <audio controls src={blobUrl} className="w-full" />
              </div>
            )}

            {!error && preview === "video" && blobUrl && (
              <div className="p-4">
                <video
                  controls
                  src={blobUrl}
                  className="mx-auto max-h-full max-w-full rounded-lg border border-border"
                />
              </div>
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
                className="p-4 text-[13px] [&_.sheet-name]:mb-1 [&_.sheet-name]:mt-4 [&_.sheet-name]:font-semibold [&_.sheet-name]:first:mt-0 [&_.sheet-truncated]:mt-2 [&_.sheet-truncated]:text-xs [&_.sheet-truncated]:text-muted-foreground [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1"
                dangerouslySetInnerHTML={{ __html: sheetHtml }}
              />
            )}

            {!error && preview === "text" && artText != null && (
              // The same renderer the file tree uses — an artifact and a
              // workspace file of the same type must not look like two
              // different features (CodeBlock is the CHAT's block: it draws a
              // language header and no line numbers).
              isMd ? (
                <div className="mx-auto max-w-3xl p-6">
                  <MarkdownViewer content={artText} />
                </div>
              ) : (
                <CodeEditor value={artText} fileName={displayName} />
              )
            )}

            {!loading && !error && preview === "none" && (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  No inline preview for this file type.
                </p>
                <button
                  type="button"
                  onClick={openExternal}
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
          <CodeEditor value={content} fileName={displayName} />
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
