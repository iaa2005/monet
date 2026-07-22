/**
 * File cards — the shared look for a produced or attached file.
 *
 * Two shapes, one vocabulary:
 *   FileCard  — a wide row (icon · name · type · action), used under a reply
 *               and in the Artifacts panel.
 *   FileTile  — a square tile for the Content grid, showing a preview when the
 *               file is an image and the name + type badge otherwise.
 *
 * The action button carries the OS icon of whatever app owns the extension, so
 * the button shows what will actually open — Acrobat for a .pdf, the user's
 * editor for a .tex. That icon comes from the shell (app.getFileIcon), not from
 * bundled brand art.
 */

import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Download,
  FileText,
  Image as ImageIcon,
  Paperclip,
  SquareArrowOutUpRight,
  Video,
  X,
} from "lucide-react";
import type { ArtifactItem } from "@/lib/sessionArtifacts";
import { isPdf, pdfThumbnail } from "@/lib/pdfThumb";
import { useChatStore } from "@/stores/chatStore";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

// ─── Primitives ─────────────────────────────────────────────────────────
// These live here, in the leaf module, so ArtifactsPanel can build on the
// cards without the two files importing each other. ArtifactsPanel re-exports
// them for the callers that have always imported them from there.

export function openArtifact(path?: string): void {
  if (path) void api()?.artifacts.open(path);
}

/** Open a file in the in-app viewer drawer. */
export function viewArtifact(a: {
  name: string;
  path?: string;
  mediaType: string;
  kind: string;
  dataUrl?: string;
}): void {
  useChatStore.getState().openViewer({ ...a, source: "artifact" });
}

export function KindIcon({
  kind,
  className = "size-3.5",
}: {
  kind: ArtifactItem["kind"];
  className?: string;
}): JSX.Element {
  if (kind === "audio")
    return <AudioLines className={`${className} shrink-0 text-violet-500`} />;
  if (kind === "video")
    return <Video className={`${className} shrink-0 text-orange-500`} />;
  if (kind === "file")
    return <Paperclip className={`${className} shrink-0 text-red-text`} />;
  if (kind === "image")
    return <ImageIcon className={`${className} shrink-0 text-green-text`} />;
  return <FileText className={`${className} shrink-0 text-muted-foreground`} />;
}

/** The artifact's image as a data URL, re-read from disk when the in-memory
 * one is gone (chat switch / reload). null until/unless one is available. */
export function useArtifactImage(a: {
  dataUrl?: string;
  path?: string;
  mediaType: string;
}): string | null {
  const [url, setUrl] = useState<string | null>(a.dataUrl ?? null);

  useEffect(() => {
    if (url || !a.path) return;
    let alive = true;
    void api()
      ?.artifacts.readImage(a.path, a.mediaType)
      .then((r) => {
        if (alive && r.ok && r.dataUrl) setUrl(r.dataUrl);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.path]);

  return url;
}

function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Page 1 of a PDF, rendered once and cached by `key`. null key = not a PDF,
 * or nothing to read it from. */
export function usePdfThumb(
  key: string | null,
  load: () => Promise<Uint8Array | null>,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  // The loader closes over props and is a new function every render; keep it
  // out of the effect's deps or the render would restart on every tick.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!key) return;
    let alive = true;
    void pdfThumbnail(key, () => loadRef.current()).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [key]);

  return url;
}

/** Image preview that falls back to re-reading the on-disk artifact when the
 * in-memory data URL is gone (chat switch / reload). */
export function ArtifactThumb({
  a,
  className,
  onClick,
}: {
  a: { dataUrl?: string; path?: string; name: string; mediaType: string };
  className?: string;
  /** Click handler. Nothing opens in the OS unless the caller asks for it —
   * clicking a preview should open the in-app viewer, not the OS app. */
  onClick?: () => void;
}): JSX.Element | null {
  const url = useArtifactImage(a);

  if (!url) return null;
  return (
    <img
      src={url}
      alt={a.name}
      title={a.name}
      onClick={onClick}
      className={cn(
        className ?? "max-h-40 w-full object-cover",
        onClick && "cursor-pointer",
      )}
    />
  );
}

// ─── Cards ──────────────────────────────────────────────────────────────

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Human category for an extension. Only the families worth naming are here —
 * anything else shows its bare extension, which reads better than inventing a
 * label ("TEX" beats "Text · TEX"). */
const FAMILY: Record<string, string> = {
  pdf: "Document",
  doc: "Document",
  docx: "Document",
  odt: "Document",
  rtf: "Document",
  xls: "Spreadsheet",
  xlsx: "Spreadsheet",
  ods: "Spreadsheet",
  csv: "Spreadsheet",
  tsv: "Spreadsheet",
  ppt: "Presentation",
  pptx: "Presentation",
  odp: "Presentation",
  zip: "Archive",
  tar: "Archive",
  gz: "Archive",
  "7z": "Archive",
  rar: "Archive",
};

export function typeLabel(a: {
  name: string;
  mediaType: string;
  kind: ArtifactItem["kind"];
}): string {
  const ext = extOf(a.name);
  const family =
    FAMILY[ext] ??
    (a.kind === "image"
      ? "Image"
      : a.kind === "audio"
        ? "Audio"
        : a.kind === "video"
          ? "Video"
          : "");
  const tag = ext ? ext.toUpperCase() : a.mediaType.split("/").pop()?.toUpperCase() ?? "FILE";
  return family ? `${family} · ${tag}` : tag;
}

/** Two stacked sheets — the "this is a file" mark used on every card. */
export function StackedDocIcon({
  className,
}: {
  className?: string;
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 44 48"
      fill="none"
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      <g strokeWidth="1.6">
        {/* back sheet — tilted and peeking up-left, so the mark reads as a
            stack rather than a single page */}
        <rect
          x="4"
          y="4"
          width="25"
          height="33"
          rx="5"
          className="fill-muted/50 stroke-border"
          transform="rotate(-9 16.5 20.5)"
        />
        {/* front sheet, opaque so it sits on top of the tilted one */}
        <rect
          x="12"
          y="10"
          width="27"
          height="34"
          rx="5"
          className="fill-card stroke-border"
        />
      </g>
      {/* small document glyph centred on the front sheet */}
      <g
        className="stroke-muted-foreground"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 22h6.5l2.5 2.5V33h-9z" />
        <path d="M27.5 22v2.5H30" />
      </g>
    </svg>
  );
}

/** The OS icon for this file's default app; falls back to the kind glyph. */
export function AppIcon({
  a,
  className = "size-4",
}: {
  a: { path?: string; kind: ArtifactItem["kind"] };
  className?: string;
}): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!a.path) return;
    let alive = true;
    void api()
      ?.artifacts.appIcon(a.path)
      .then((r) => {
        if (alive && r.ok && r.dataUrl) setUrl(r.dataUrl);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [a.path]);

  if (!url) return <KindIcon kind={a.kind} className={className} />;
  return <img src={url} alt="" className={cn(className, "shrink-0")} />;
}

export function openWithOS(path?: string): void {
  if (path) void api()?.artifacts.open(path);
}

/** Save copies of several files into one folder the user picks. */
export function DownloadAllButton({
  items,
  className,
  compact,
}: {
  items: ArtifactItem[];
  className?: string;
  /** Header variant: plain text, no pill. */
  compact?: boolean;
}): JSX.Element | null {
  const withPath = items.filter((i) => i.path);
  const [saved, setSaved] = useState<number | null>(null);
  if (withPath.length === 0) return null;

  const run = async (): Promise<void> => {
    const r = await api()?.artifacts.downloadAll(
      withPath.map((i) => ({ path: i.path!, name: i.name })),
    );
    if (r?.ok) {
      setSaved(r.saved ?? withPath.length);
      setTimeout(() => setSaved(null), 2500);
    }
  };

  const label =
    saved !== null ? `Saved ${saved} file${saved === 1 ? "" : "s"}` : "Download all";

  return (
    <button
      type="button"
      onClick={() => void run()}
      title={`Save ${withPath.length} file(s) to a folder`}
      className={cn(
        compact
          ? "flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          : // Bordered: this one sits on the chat background, where `muted`
            // alone is nearly the same colour and the pill disappears.
            "flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2 text-sm font-medium transition-colors hover:bg-muted",
        className,
      )}
    >
      <Download className={compact ? "size-3.5" : "size-4"} />
      {label}
    </button>
  );
}

/**
 * Wide file row. `action` picks the trailing control:
 *   "open"  — a labelled pill (under a reply, where there is room)
 *   "icon"  — a bare icon button (the narrow side panel)
 */
export function FileCard({
  a,
  action = "open",
  older,
}: {
  a: ArtifactItem;
  action?: "open" | "icon";
  /** Earlier copies of this same file, newest first. */
  older?: ArtifactItem[];
}): JSX.Element {
  const [showVersions, setShowVersions] = useState(false);
  const versions = older?.length ?? 0;

  return (
    <div className="rounded-2xl border border-border bg-card">
    <div className="flex items-center gap-3 px-3 py-2.5">
      <button
        type="button"
        onClick={() => viewArtifact(a)}
        title={`Preview ${a.name}`}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <StackedDocIcon className="size-11" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{a.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {typeLabel(a)}
          </span>
        </span>
      </button>
      {versions > 0 && (
        // Outside the preview button — nesting one button in another is
        // invalid and breaks keyboard activation.
        <button
          type="button"
          onClick={() => setShowVersions((v) => !v)}
          title={`${versions} earlier version${versions === 1 ? "" : "s"} of this file`}
          className={cn(
            "shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums transition-colors",
            showVersions
              ? "bg-foreground text-background"
              : "bg-muted text-muted-foreground hover:text-foreground",
          )}
        >
          v{versions + 1}
        </button>
      )}
      {action === "open" ? (
        <button
          type="button"
          onClick={() => openWithOS(a.path)}
          disabled={!a.path}
          title="Open with the system app"
          className={cn(
            "flex shrink-0 items-center gap-2 rounded-xl bg-muted px-3 py-2 text-sm font-medium transition-colors",
            a.path ? "hover:bg-muted/70" : "opacity-40",
          )}
        >
          <AppIcon a={a} className="size-4" />
          Open
        </button>
      ) : (
        <button
          type="button"
          onClick={() => openWithOS(a.path)}
          disabled={!a.path}
          title="Open with the system app"
          className={cn(
            "shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors",
            a.path
              ? "hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
              : "opacity-40",
          )}
        >
          <SquareArrowOutUpRight className="size-4" />
        </button>
      )}
    </div>
    {showVersions && older && (
      <div className="border-t border-border px-3 py-1.5">
        {older.map((v, i) => (
          <button
            key={`${v.ts}-${i}`}
            type="button"
            onClick={() => viewArtifact(v)}
            className="flex w-full items-center justify-between gap-3 rounded-md px-1 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.05]"
          >
            <span>v{older.length - i}</span>
            <span className="tabular-nums">
              {new Date(v.ts).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          </button>
        ))}
      </div>
    )}
    </div>
  );
}

/**
 * The tile itself, on plain props — shared by the Content grid (artifacts on
 * disk) and the composer (files staged but not sent), so the two cannot drift
 * apart. A thumbnail fills the tile and the badge floats over it; without one
 * the name sits above the badge.
 */
export function FilePreviewTile({
  name,
  badge,
  meta,
  thumbUrl,
  onClick,
  onRemove,
}: {
  name: string;
  badge: string;
  /** Small grey line under the name (size, line count). */
  meta?: string;
  thumbUrl?: string;
  onClick?: () => void;
  /** Renders a remove control that appears on hover. */
  onRemove?: () => void;
}): JSX.Element {
  return (
    <div
      className={cn(
        "group relative h-36 overflow-hidden rounded-xl border border-border bg-card transition-colors",
        onClick && "hover:border-muted-foreground/40",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        title={name}
        disabled={!onClick}
        className="flex h-full w-full flex-col text-left"
      >
        {thumbUrl ? (
          <img src={thumbUrl} alt={name} className="h-full w-full object-cover" />
        ) : (
          <>
            <span
              className={cn(
                "min-h-0 flex-1 overflow-hidden px-3 pt-3",
                // Keep the first line clear of the remove button.
                onRemove && "pr-8",
              )}
            >
              {/* overflow-wrap:anywhere, not break-all and not break-words.
                  break-all splits mid-word ("технологическая карта.d/oc");
                  break-word refuses to split "Вопросы_подготовка_экзамен_…"
                  at all and lets it run off the tile. anywhere prefers word
                  boundaries and still breaks a token that cannot fit. */}
              <span className="line-clamp-3 text-xs font-medium leading-snug [overflow-wrap:anywhere]">
                {name}
              </span>
              {meta && (
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  {meta}
                </span>
              )}
            </span>
            <span className="px-3 pb-3">
              <TypeBadge>{badge}</TypeBadge>
            </span>
          </>
        )}
      </button>
      {thumbUrl && (
        // Over an image the badge needs its own backing — a light page would
        // swallow a plain muted chip.
        <span className="pointer-events-none absolute bottom-2 left-2">
          <TypeBadge onImage>{badge}</TypeBadge>
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          title="Remove"
          className="absolute right-1.5 top-1.5 rounded-full bg-background/80 p-1 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function TypeBadge({
  children,
  onImage,
}: {
  children: React.ReactNode;
  onImage?: boolean;
}): JSX.Element {
  return (
    <span
      className={cn(
        "inline-block rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide",
        onImage
          ? "bg-black/60 text-white"
          : "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** Square tile for the Content grid: a preview when we have one, otherwise the
 * name over a type badge. */
export function FileTile({ a }: { a: ArtifactItem }): JSX.Element {
  const [lines, setLines] = useState<number | null>(null);
  const isImage = a.kind === "image" && Boolean(a.dataUrl || a.path);
  const thumb = useArtifactImage(a);
  const pdf = usePdfThumb(
    isPdf(a.name, a.mediaType) && a.path ? a.path : null,
    async () => {
      const r = await api()?.artifacts.readBytes(a.path!);
      return r?.ok && r.base64 ? bytesFromBase64(r.base64) : null;
    },
  );

  useEffect(() => {
    // A line count is only meaningful for text, and only worth a read for a
    // file small enough that readText will accept it anyway.
    if (isImage || !a.path || !TEXTY.has(extOf(a.name))) return;
    let alive = true;
    void api()
      ?.artifacts.readText(a.path)
      .then((r) => {
        if (alive && r.ok && r.content !== undefined)
          setLines(r.content.split("\n").length);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [a.path, a.name, isImage]);

  return (
    <FilePreviewTile
      name={a.name}
      badge={extOf(a.name).toUpperCase() || "FILE"}
      meta={lines !== null ? `${lines} lines` : undefined}
      thumbUrl={(isImage ? thumb : pdf) ?? undefined}
      onClick={() => viewArtifact(a)}
    />
  );
}

/** A file staged in the composer, not sent yet. Reads its bytes straight from
 * the File — there is nothing on disk to read back. */
export function StagedFileTile({
  file,
  id,
  previewUrl,
  onRemove,
}: {
  file: File;
  /** Stable across renders — used as the thumbnail cache key. */
  id: string;
  /** Object URL, for images (the composer already made one). */
  previewUrl?: string;
  onRemove: () => void;
}): JSX.Element {
  const pdf = usePdfThumb(
    isPdf(file.name, file.type) ? id : null,
    async () => new Uint8Array(await file.arrayBuffer()),
  );
  const thumb = file.type.startsWith("image/") ? previewUrl : (pdf ?? undefined);
  return (
    <FilePreviewTile
      name={file.name}
      badge={extOf(file.name).toUpperCase() || "FILE"}
      meta={formatBytes(file.size)}
      thumbUrl={thumb}
      onRemove={onRemove}
    />
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const TEXTY = new Set([
  "txt", "md", "tex", "csv", "tsv", "json", "yaml", "yml", "xml", "html",
  "css", "js", "ts", "tsx", "jsx", "py", "sh", "sql", "toml", "ini", "log",
]);
