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

/**
 * The one row to take without reading the other six.
 *
 * RNN-T over CTC: it writes punctuation itself, and the difference shows on
 * dictated speech, where the alternative is one long unbroken sentence. The
 * multilingual pair are for languages GigaAM's Russian models do not cover,
 * and "large" costs 592 MB for that reach — neither is the default answer.
 */
const RECOMMENDED_MODEL = "gigaam-v3-rnnt-punct";

import { useEffect, useState } from "react";
import { Cpu, Loader2, Trash2, X } from "@/components/icons/hg";
import { PickCard } from "@/components/settings/PickCard";
import { RecommendedChip } from "@/components/settings/RecommendedChip";
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
    <div className="flex flex-col gap-1.5">
      {models.map((m) => {
        const p = progress[m.id];
        const isSelected = selected === m.id;
        return (
          <PickCard
            key={m.id}
            icon={Cpu}
            title={m.label}
            badge={m.id === RECOMMENDED_MODEL ? <RecommendedChip /> : null}
            description={`${m.languages} \u00b7 ${mb(m.bytes)}${
              m.punctuation ? " \u00b7 punctuation" : ""
            }`}
            selected={isSelected}
            needsDownload={!m.installed}
            progress={p ? p.percent : null}
            onClick={() => {
              onSelect(m.id);
              if (!m.installed && !p) install(m.id);
            }}
            trailing={
              p ? (
                <button
                  type="button"
                  onClick={() => void api()?.stt.cancelInstall(m.id)}
                  title="Cancel download"
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
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
                  className="mt-1.5 shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </button>
              ) : null
            }
          >
            {/* The long note only for the row you chose: four of these at once
                is a wall, and the one that matters is the current one. */}
            {isSelected && !p && (
              <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
                {m.note}
              </span>
            )}
          </PickCard>
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
