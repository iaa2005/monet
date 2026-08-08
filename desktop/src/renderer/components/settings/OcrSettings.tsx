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
import { SectionTitle } from "@/components/settings/SectionTitle";

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
        <SectionTitle>OCR Scanner</SectionTitle>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Lets the assistant read scans, PDFs and screenshots — text, formulas
          and tables. Runs on this computer; nothing is uploaded.
        </p>
      </section>

      <div className="space-y-1.5">
        {models.map((m) => {
          const v = m.variants[0];
          const busy = progress?.modelId === m.id;
          const chosen = cfg?.modelId === m.id;
          return (
            <div
              key={m.id}
              className={cn(
                "rounded-lg border border-border bg-card px-3 py-2.5",
                chosen && v.installed && "border-brand/40 bg-brand/[0.04]",
              )}
            >
              <div className="flex items-center gap-2">
                <FileScan
                  className={cn(
                    "size-4 shrink-0",
                    chosen && v.installed ? "text-brand" : "text-muted-foreground",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{m.label}</span>
                    {chosen && v.installed && (
                      <span className="shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] text-brand">
                        in use
                      </span>
                    )}
                  </div>
                  <p className="truncate text-[12px] text-muted-foreground">
                    {m.short} · {v.size}
                    {m.secondsPerPage ? ` · ~${m.secondsPerPage}s a page` : ""}
                  </p>
                </div>

                {busy ? (
                  <button
                    type="button"
                    onClick={() => void api()?.cancelInstall(m.id, v.dtype)}
                    className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <X className="size-3" />
                    {progress?.percent ?? 0}%
                  </button>
                ) : !v.installed ? (
                  <button
                    type="button"
                    onClick={() => void install(m.id, v.dtype)}
                    className="flex shrink-0 items-center gap-1 rounded-md bg-foreground px-2.5 py-1 text-[11px] font-medium text-background transition-opacity hover:opacity-90"
                  >
                    <Download className="size-3" />
                    Download
                  </button>
                ) : !chosen ? (
                  <button
                    type="button"
                    onClick={() => void patch({ modelId: m.id, dtype: v.dtype })}
                    className="shrink-0 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                  >
                    Use
                  </button>
                ) : (
                  <button
                    type="button"
                    title="Delete the files"
                    onClick={() => void api()?.remove(m.id).then(() => load())}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>

              {busy && progress && (
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.1]">
                  <div
                    className="h-full bg-brand transition-[width]"
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>
              )}
            </div>
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
