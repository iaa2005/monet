import { useState } from "react";
import { Check, Download, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

const FORMATS: {
  id: "monet" | "markdown";
  title: string;
  blurb: string;
}[] = [
  {
    id: "monet",
    title: "Code Monet bundle (.monet.json)",
    blurb:
      "Full chat: every message with tool inputs/outputs, plus produced files. Re-importable into Code Monet to continue the chat.",
  },
  {
    id: "markdown",
    title: "Markdown (.md)",
    blurb:
      "Readable transcript for a person or another AI agent. Files are listed, not embedded.",
  },
];

export function ExportChatModal({
  sessionId,
  title,
  onClose,
}: {
  sessionId: string;
  title: string;
  onClose: () => void;
}): JSX.Element {
  const [format, setFormat] = useState<"monet" | "markdown">("monet");
  const [includeArtifacts, setIncludeArtifacts] = useState(true);
  const [includeContext, setIncludeContext] = useState(false);
  const [includeRawTools, setIncludeRawTools] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await api()?.transfer.exportChat(sessionId, {
        format,
        includeArtifacts,
        includeContext,
        includeRawTools,
      });
      if (r?.ok && r.path) setSaved(r.path);
      else if (r?.canceled) onClose();
      else setError(r?.error ?? "Export failed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Export “${title || "chat"}”`}>
      {saved ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <Check className="size-4 text-green-text" />
            Saved
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground" title={saved}>
            {saved}
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFormat(f.id)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors",
                  format === f.id
                    ? "border-foreground/40 ring-1 ring-foreground/20"
                    : "border-border hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                    format === f.id
                      ? "border-transparent bg-foreground text-background"
                      : "border-border",
                  )}
                >
                  {format === f.id && <Check className="size-3" />}
                </span>
                <span className="min-w-0">
                  <span className="text-sm font-medium">{f.title}</span>
                  <span className="mt-0.5 block text-[13px] text-muted-foreground">
                    {f.blurb}
                  </span>
                </span>
              </button>
            ))}
          </div>

          <div className="space-y-2">
            {format === "monet" && (
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  Include produced files &amp; attachments
                  <span className="mt-0.5 block text-[13px] text-muted-foreground">
                    Embeds the chat&apos;s files so the recipient gets them too.
                  </span>
                </span>
                <Switch checked={includeArtifacts} onChange={setIncludeArtifacts} />
              </label>
            )}
            {format === "markdown" && (
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  Include raw tool blocks
                  <span className="mt-0.5 block text-[13px] text-muted-foreground">
                    Off: compact one-line tool calls. On: full, untruncated tool
                    inputs &amp; outputs — fuller context for another AI agent.
                  </span>
                </span>
                <Switch checked={includeRawTools} onChange={setIncludeRawTools} />
              </label>
            )}
            <label className="flex items-center justify-between gap-4 text-sm">
              <span>
                Include your profile &amp; memory
                <span className="mt-0.5 block text-[13px] text-muted-foreground">
                  Off by default — this is personal context, not part of the chat.
                </span>
              </span>
              <Switch checked={includeContext} onChange={setIncludeContext} />
            </label>
          </div>

          {error && <p className="text-[13px] text-destructive">{error}</p>}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void run()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-colors hover:opacity-90 disabled:opacity-60"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              Export
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
