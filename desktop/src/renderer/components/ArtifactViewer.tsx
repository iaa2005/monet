/**
 * Artifact viewer — a right-side drawer that previews one sandbox artifact.
 *
 * Controls: refresh (re-read from disk), download (save-as), expand (widen ↔
 * near-fullscreen), open externally, close. Images render inline; text/code
 * files show as highlighted source; anything else offers "open externally".
 * Mounted once in App; driven by chatStore.viewerArtifact.
 */

import { useEffect, useState } from "react";
import {
  Download,
  ExternalLink,
  Maximize2,
  Minimize2,
  RefreshCw,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
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
  };
  return map[ext] ?? "text";
}

const TEXT_EXT =
  /\.(txt|md|csv|tsv|json|jsonc|js|mjs|ts|tsx|py|html|css|xml|svg|yaml|yml|log)$/i;

export function ArtifactViewer(): JSX.Element | null {
  const item = useChatStore((s) => s.viewerArtifact);
  const close = useChatStore((s) => s.openArtifactViewer);
  const [expanded, setExpanded] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const path = item?.path;
  const isImage = item?.kind === "image";
  const isText = !!item && (item.kind === "text" || TEXT_EXT.test(item.name));

  useEffect(() => {
    setImgUrl(null);
    setText(null);
    setError(null);
    if (!item || !path) return;
    setLoading(true);
    const bridge = api();
    const done = (): void => setLoading(false);
    if (isImage) {
      void bridge?.artifacts
        .readImage(path, item.mediaType)
        .then((r) => (r.ok && r.dataUrl ? setImgUrl(r.dataUrl) : setError(r.error ?? "Can't read image")))
        .catch((e) => setError(String(e)))
        .finally(done);
    } else if (isText) {
      void bridge?.artifacts
        .readText(path)
        .then((r) => (r.ok ? setText(r.content ?? "") : setError(r.error ?? "Can't read file")))
        .catch((e) => setError(String(e)))
        .finally(done);
    } else {
      done();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.path, item?.name, nonce]);

  if (!item) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
      <div className="flex-1" onClick={() => close(null)} />
      <div
        className={cn(
          "flex h-full flex-col border-l border-border bg-background shadow-2xl transition-[width]",
          expanded ? "w-[min(92vw,1100px)]" : "w-[min(92vw,560px)]",
        )}
      >
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border pl-4 pr-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={item.name}>
            {item.name}
          </span>
          <IconBtn title="Refresh" onClick={() => setNonce((n) => n + 1)}>
            <RefreshCw className="size-4" />
          </IconBtn>
          <IconBtn
            title="Download"
            onClick={() => path && void api()?.artifacts.download(path, item.name)}
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

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {loading && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {error && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {!loading && !error && isImage && imgUrl && (
            <img
              src={imgUrl}
              alt={item.name}
              className="mx-auto max-w-full rounded-lg border border-border"
            />
          )}
          {!loading && !error && !isImage && isText && text != null && (
            <CodeBlock
              code={text}
              language={langFromName(item.name)}
              className="my-0"
            />
          )}
          {!loading && !error && !isImage && !isText && (
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
