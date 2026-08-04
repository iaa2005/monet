/**
 * Picking and installing an on-device speech model.
 *
 * These are 230 MB downloads, so the panel never starts one on its own: the
 * size is on the card before the click, the progress is over the WHOLE model
 * rather than the current file, and a download in flight can be cancelled and
 * leaves nothing behind.
 *
 * Selecting a model that is not installed selects it AND downloads it — the
 * alternative is a mic button that silently does nothing until you notice a
 * second button elsewhere.
 */

import { useEffect, useState } from "react";
import { Check, Download, Loader2, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ElectronAPI, InstallProgress, SttModelStatus } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

function mb(n: number): string {
  return `${Math.round(n / 1_000_000)} MB`;
}

export function SttModelPicker({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (id: string) => void;
}): JSX.Element {
  const [models, setModels] = useState<SttModelStatus[]>([]);
  const [progress, setProgress] = useState<Record<string, InstallProgress>>({});
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);

  const refresh = async (): Promise<void> => {
    const list = await api()?.stt.models();
    if (list) setModels(list);
  };

  useEffect(() => {
    void (async () => {
      setAvailable((await api()?.stt.nativeAvailable()) ?? false);
      await refresh();
    })();
    return api()?.stt.onModelProgress((p) => {
      setProgress((prev) => {
        const next = { ...prev };
        if (p.done) delete next[p.id];
        else next[p.id] = p;
        return next;
      });
      if (p.done) {
        if (p.error && p.error !== "Download cancelled") setError(p.error);
        void refresh();
      }
    });
  }, []);

  const install = (id: string): void => {
    setError(null);
    setProgress((prev) => ({
      ...prev,
      [id]: { id, loaded: 0, total: 1, percent: 0 },
    }));
    void api()
      ?.stt.installModel(id)
      .then((r) => {
        if (!r.ok && r.error && r.error !== "Download cancelled")
          setError(r.error);
        void refresh();
      });
  };

  if (!available) {
    return (
      <div className="px-1 pb-1 text-[11px] leading-snug text-muted-foreground">
        On-device recognition isn&apos;t built for this platform. Use Whisper or
        a cloud endpoint.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 px-1 pb-1">
      {models.map((m) => {
        const p = progress[m.id];
        const isSelected = selected === m.id;
        return (
          <div
            key={m.id}
            className={cn(
              "rounded-md border px-1.5 py-1 transition-colors",
              isSelected ? "border-link/40 bg-link/[0.06]" : "border-transparent",
            )}
          >
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  onSelect(m.id);
                  if (!m.installed && !p) install(m.id);
                }}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <span className="flex w-4 shrink-0 justify-center">
                  {isSelected && <Check className="size-3.5 text-link" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{m.label}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {m.languages} · {mb(m.bytes)}
                    {m.punctuation ? " · punctuation" : ""}
                  </span>
                </span>
              </button>
              {p ? (
                <button
                  type="button"
                  onClick={() => void api()?.stt.cancelInstall(m.id)}
                  title="Cancel download"
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              ) : m.installed ? (
                <button
                  type="button"
                  onClick={() =>
                    void api()
                      ?.stt.removeModel(m.id)
                      .then(refresh)
                  }
                  title="Delete the downloaded files"
                  className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => install(m.id)}
                  title={`Download ${mb(m.bytes)}`}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <Download className="size-3.5" />
                </button>
              )}
            </div>
            {p && (
              <div className="mt-1 flex items-center gap-1.5 pl-5">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.1]">
                  <div
                    className="h-full rounded-full bg-link transition-[width]"
                    style={{ width: `${p.percent}%` }}
                  />
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {p.percent}%
                </span>
              </div>
            )}
            {isSelected && !p && (
              <div className="pl-5 pt-0.5 text-[11px] leading-snug text-muted-foreground">
                {m.note}
              </div>
            )}
          </div>
        );
      })}
      {error && (
        <div className="rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {error}
        </div>
      )}
      <div className="flex items-center gap-1 px-1 text-[11px] leading-snug text-muted-foreground">
        <Loader2 className="hidden size-3" />
        Runs on your machine, no key and no network once downloaded.
      </div>
    </div>
  );
}
