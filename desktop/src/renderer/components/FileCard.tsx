/**
 * File cards — the shared look for a produced or attached file.
 *
 * Two shapes, one vocabulary:
 *   FileCard  — a wide row (icon · name · type · action), used under a reply
 *               and in the Artifacts panel.
 *   FileTile  — a square tile for the Content grid, showing a preview when the
 *               file is an image and the name + type badge otherwise.
 *
 * The mark on the left is the same flow icon set the file tree uses, so a
 * file looks the same wherever the app shows it. The action button is a plain
 * label: it used to carry the OS icon of whatever app owns the extension, which
 * put a second, differently-drawn icon of the same file on the same row.
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
import { isPdf } from "@/lib/pdfThumb";
import { useChatStore } from "@/stores/chatStore";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";
import { useIsDark } from "@/components/chat/highlight";
import { fallbackIcon, resolveIcon } from "@/components/icon-resolver";
import { viewArtifact } from "@/components/artifact-actions";
import {
  bytesFromBase64,
  extOf,
  openWithOS,
  typeLabel,
  useArtifactImage,
  usePdfThumb,
} from "@/components/artifact-media";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

// ─── Primitives ─────────────────────────────────────────────────────────
// These live here, in the leaf module, so ArtifactsPanel can build on the
// cards without the two files importing each other. The two ACTIONS live in
// artifact-actions: a file that exports a component and a plain function
// cannot be hot-updated, and reloading the page loses the conversation.

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

/**
 * One sheet of paper, corner turned down, cut off by the bottom of the card.
 *
 * There is no plate. An earlier version put the sheet on a white rounded square
 * and the reference has none — the sheet IS the light thing, sitting straight on
 * the grey row, and it is the row's own bottom edge that crops it. Compared side
 * by side that was the only difference left.
 *
 * The icon on the sheet is the same flow icon set the file tree uses, through
 * the same resolver, so a `.ts` here and a `.ts` in the tree are one picture — and
 * a name the set has no icon for falls back the way the tree falls back.
 *
 * The fold is a real fold: the outline stops short of the corner and the
 * turned-down flap is drawn over it, so the two edges meet the way paper does.
 */
export function StackedDocIcon({
  className,
  name,
}: {
  className?: string;
  /** Filename, for picking the icon that goes on the sheet. */
  name?: string;
}): JSX.Element {
  const dark = useIsDark();
  const src = name ? resolveIcon(name, false, false, dark) : null;
  return (
    // The layout box is shorter than the sheet: the overflow goes DOWN, and the
    // row (overflow-hidden, rounded) is what cuts it off.
    // Proportions read off the reference at full zoom: the sheet is about 0.8 as
    // wide as it is tall (mine was 0.68 and looked like a different object), it
    // stands about 80% of the card's height, and roughly a tenth of it is cut off
    // at the bottom.
    <span className={cn("relative block h-11 w-12 shrink-0", className)}>
      <span
        className={cn(
          // Turning about the sheet's own centre, anticlockwise.
          "absolute left-0 top-1.5 block h-[3.75rem] w-full origin-center",
          // NOT behind motion-safe, and that is deliberate. Tailwind compiles
          // motion-safe into `@media (prefers-reduced-motion: no-preference)`,
          // and this machine answers `reduce` — Windows has "show animations"
          // off — so the whole block was dead and the swing never happened
          // anywhere. Same cause as the spinner that would not spin, and the
          // same answer: reduce the movement rather than remove it, since the
          // person asking for less movement is the one who asked for this.
          "transition-transform duration-300 ease-out motion-reduce:duration-150",
          "group-hover:-rotate-[7deg] group-hover:scale-[1.06]",
        )}
      >
        <svg viewBox="0 0 36 45" fill="none" className="h-full w-full" aria-hidden="true">
          {/* The page. Its top-right is cut, and that diagonal belongs to THIS
              path — the flap must not draw it a second time. */}
          <path
            d="M1 4.5a3.5 3.5 0 0 1 3.5-3.5H25L35 11V40.5a3.5 3.5 0 0 1-3.5 3.5H4.5A3.5 3.5 0 0 1 1 40.5z"
            className="fill-card stroke-muted-foreground/30"
            strokeWidth="1"
            strokeLinejoin="round"
          />
          {/* The turned-down flap, filled only. */}
          <path
            d="M25 1v6.5a3.5 3.5 0 0 0 3.5 3.5H35z"
            className="fill-muted-foreground/15"
          />
          {/* ...and its crease, as an OPEN path. Closing it would lay a second
              line along the diagonal the page already draws, and two 1px strokes
              on the same edge read as a brighter line than the rest of the
              outline — which is what you could see. */}
          <path
            d="M25 1v6.5a3.5 3.5 0 0 0 3.5 3.5H35"
            className="stroke-muted-foreground/30"
            strokeWidth="1"
            strokeLinejoin="round"
          />
        </svg>
        {src && (
          <img
            src={src}
            alt=""
            aria-hidden
            className="absolute left-1/2 top-[48%] h-[38%] w-[46%] -translate-x-1/2 -translate-y-1/2 object-contain"
            onError={(e) => {
              const img = e.currentTarget;
              const back = fallbackIcon(false, false, dark);
              if (!img.src.endsWith(back)) img.src = back;
            }}
          />
        )}
      </span>
    </span>
  );
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
  surface = "chat",
}: {
  a: ArtifactItem;
  action?: "open" | "icon";
  /** Earlier copies of this same file, newest first. */
  older?: ArtifactItem[];
  /** Which background it sits on: the chat, or the Artifacts panel. */
  surface?: "chat" | "panel";
}): JSX.Element {
  const [showVersions, setShowVersions] = useState(false);
  const versions = older?.length ?? 0;

  // The fill follows the surface. Under a reply the card carries the chat's own
  // background, so only its border and the white sheet separate it from the
  // canvas; in the Artifacts panel that would sink into the panel, so it takes
  // the lifted `card` instead.
  //
  // `glass-panel` puts it in the Monet glass system: with a painting behind the
  // app, `.monet-glass` makes these transparent with a blurred backdrop, and a
  // card without the class stays an opaque block in the middle of it.
  return (
    <div
      className={cn(
        "group glass-panel rounded-lg border border-border",
        surface === "panel" ? "bg-card" : "bg-card",
      )}
    >
    {/* overflow-hidden here is the crop: the sheet is taller than its box and
        the row's own rounded bottom edge cuts it off. On the row rather than the
        outer card so the versions list below keeps its square corners. */}
    <div className="flex items-center gap-3 overflow-hidden rounded-lg px-3 py-2.5">
      <button
        type="button"
        onClick={() => viewArtifact(a)}
        title={`Preview ${a.name}`}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        {/* The plate turns and grows a little under the cursor. Behind
            motion-safe: it is decoration, so someone who asked the OS for less
            movement gets the same card without the swing — unlike the busy
            spinner, which has to keep moving because it is telling them
            something. */}
        <StackedDocIcon
          name={a.name}
          className={cn(
            "size-12 transition-transform duration-300 ease-out",
            "motion-safe:group-hover:-rotate-6 motion-safe:group-hover:scale-[1.06]",
          )}
        />
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
