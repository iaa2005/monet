/**
 * Settings → OCR Scanner.
 *
 * Deliberately short. The scanner has a lot of hard-won detail behind it —
 * which weight format is correct on which backend, why a page is read block
 * by block, what each model gets wrong — and none of that belongs here.
 * Somebody opening this page wants to answer one question: which model, and
 * is it downloaded. The detail lives in Help and in the model files.
 *
 * So: one line per model with the two numbers that decide it (size, seconds
 * a page), one button, and everything else folded away under Advanced.
 */

import { useEffect, useState } from "react";
import {
  ChevronDown,
  Download,
  FileScan,
  Loader2,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";
import {
  SectionHeader,
  SectionTitle,
} from "@/components/settings/SectionTitle";
import { PickCard } from "@/components/settings/PickCard";

type UiOcrModel = Awaited<ReturnType<NonNullable<ElectronAPI["ocr"]>["models"]>>[number];
type OcrConfig = Awaited<ReturnType<NonNullable<ElectronAPI["ocr"]>["config"]>>;
type Progress = Parameters<
  Parameters<NonNullable<ElectronAPI["ocr"]>["onInstallProgress"]>[0]
>[0];

function api(): NonNullable<ElectronAPI["ocr"]> | undefined {
  return window.electronAPI?.ocr;
}

export function OcrSettings(): React.JSX.Element {
  const [models, setModels] = useState<UiOcrModel[]>([]);
  const [cfg, setCfg] = useState<OcrConfig | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [layout, setLayout] = useState<{
    installed: boolean;
    size: string;
  } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{
    text?: string;
    error?: string;
    seconds?: number;
  } | null>(null);

  const load = async (): Promise<void> => {
    const a = api();
    if (!a) return;
    setModels(await a.models());
    setCfg(await a.config());
    setLayout(await a.layoutStatus());
  };

  useEffect(() => {
    void load();
    return api()?.onInstallProgress((p) => {
      setProgress(p.done ? null : p);
      if (p.done) void load();
    });
  }, []);

  const patch = async (next: Partial<OcrConfig>): Promise<void> => {
    const a = api();
    if (!a) return;
    setCfg(await a.setConfig(next));
    void load();
  };

  /** Installing a model without the block finder gives a scanner that takes
   * four minutes a page, so the two are one action. */
  const install = async (id: string, dtype: string): Promise<void> => {
    const a = api();
    if (!a) return;
    if (!layout?.installed) await a.installLayout();
    await a.install(id, dtype);
    await load();
  };

  const pickAndTest = async (): Promise<void> => {
    const path = await api()?.pickFile();
    if (!path) return;
    setTesting(true);
    setTest(null);
    try {
      setTest((await api()?.test(path)) ?? { error: "No answer." });
    } finally {
      setTesting(false);
    }
  };

  const ready = models.some((m) => m.variants.some((v) => v.installed));

  return (
    <div className="space-y-4">
      <section>
        <SectionHeader
        title="OCR Scanner"
        description="Lets the assistant read scans, PDFs and screenshots — text, formulas and tables. Runs on this computer; nothing is uploaded."
      />
      </section>

      <div className="space-y-1.5">
        {models.map((m) => {
          const v = m.variants[0];
          const busy = progress?.modelId === m.id;
          const chosen = cfg?.modelId === m.id;
          return (
            <PickCard
              key={m.id}
              icon={FileScan}
              title={m.label}
              badge={
                chosen && v.installed ? (
                  <span className="shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] text-brand">
                    in use
                  </span>
                ) : v.partial && !busy ? (
                  // A stopped download leaves files that LOOK like an
                  // install; saying so here is what stops the scanner from
                  // failing later on a missing weight file.
                  <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                    unfinished
                  </span>
                ) : null
              }
              description={
                v.partial && !busy
                  ? `Download stopped part-way \u00b7 click to resume (keeps what it has)`
                  : `${m.short} \u00b7 ${v.size}${
                      m.secondsPerPage ? ` \u00b7 ~${m.secondsPerPage}s a page` : ""
                    }`
              }
              selected={chosen && v.installed}
              needsDownload={!v.installed}
              progress={busy ? (progress?.percent ?? 0) : null}
              onClick={
                v.installed && !chosen
                  ? () => void patch({ modelId: m.id, dtype: v.dtype })
                  : !v.installed && !busy
                    ? () => void install(m.id, v.dtype)
                    : undefined
              }
              trailing={
                busy ? (
                  <button
                    type="button"
                    title="Cancel the download"
                    onClick={() => void api()?.cancelInstall(m.id, v.dtype)}
                    className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : chosen && v.installed ? (
                  <button
                    type="button"
                    title="Delete the files"
                    onClick={() => void api()?.remove(m.id).then(() => load())}
                    className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                ) : null
              }
            />
          );
        })}
      </div>

      {ready && (
        <button
          type="button"
          disabled={testing}
          onClick={() => void pickAndTest()}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-black/[0.04] disabled:opacity-50 dark:hover:bg-white/[0.05]"
        >
          {testing && <Loader2 className="size-3.5 animate-spin" />}
          {testing ? "Reading…" : "Try it on a file"}
        </button>
      )}

      {test?.error && (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-[12px] text-amber-600 dark:text-amber-400">
          {test.error}
        </p>
      )}
      {test?.text && (
        <div>
          <p className="text-[11px] text-muted-foreground">
            One page in {test.seconds}s
          </p>
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.03] p-2.5 font-mono text-[11px] leading-relaxed dark:bg-white/[0.04]">
            {test.text}
          </pre>
        </div>
      )}

      {cfg && (
        <div>
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown
              className={cn("size-3.5 transition-transform", advanced && "rotate-180")}
            />
            Advanced
          </button>

          {advanced && (
            <div className="mt-2 space-y-3 rounded-lg border border-border bg-card p-3">
              <label className="block text-[13px]">
                <span className="text-muted-foreground">Run on</span>
                <select
                  value={cfg.device}
                  onChange={(e) =>
                    void patch({ device: e.target.value as OcrConfig["device"] })
                  }
                  className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px] outline-none focus:border-brand"
                >
                  <option value="auto">Automatic</option>
                  <option value="webgpu">Graphics card</option>
                  <option value="cpu">Processor</option>
                </select>
              </label>

              <label className="block text-[13px]">
                <span className="text-muted-foreground">
                  Detail — {cfg.dpi} DPI
                </span>
                <input
                  type="range"
                  min={100}
                  max={220}
                  step={10}
                  value={cfg.dpi}
                  onChange={(e) => void patch({ dpi: Number(e.target.value) })}
                  className="mt-1 w-full accent-brand"
                />
              </label>

              <label className="block text-[13px]">
                <span className="text-muted-foreground">
                  Pages per scan — {cfg.maxPages}
                </span>
                <input
                  type="range"
                  min={1}
                  max={200}
                  value={cfg.maxPages}
                  onChange={(e) => void patch({ maxPages: Number(e.target.value) })}
                  className="mt-1 w-full accent-brand"
                />
              </label>

              <p className="text-[11px] text-muted-foreground">
                Block finder: {layout?.installed ? "installed" : `not installed (${layout?.size ?? "124 MB"})`}
                {!layout?.installed && (
                  <button
                    type="button"
                    onClick={() => void api()?.installLayout().then(() => load())}
                    className="ml-2 underline hover:text-foreground"
                  >
                    download
                  </button>
                )}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
