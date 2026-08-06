/**
 * Settings → OCR Scanner.
 *
 * The scanner is the app's answer to a chat model that cannot see. This page
 * is where its model is installed and where the two things nobody can guess
 * for the user are decided: which weight precision, and whether the GPU on
 * THIS machine is actually faster than its CPU.
 *
 * Hence the "Try it on a file" button. Benchmarks in a README are somebody
 * else's hardware; a page from the user's own PDF, timed here, is the answer.
 */

import { useEffect, useState } from "react";
import {
  Cpu,
  Download,
  FileScan,
  LayoutTemplate,
  Loader2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

type UiOcrModel = Awaited<ReturnType<NonNullable<ElectronAPI["ocr"]>["models"]>>[number];
type OcrConfig = Awaited<ReturnType<NonNullable<ElectronAPI["ocr"]>["config"]>>;
type Progress = Parameters<
  Parameters<NonNullable<ElectronAPI["ocr"]>["onInstallProgress"]>[0]
>[0];

function api(): NonNullable<ElectronAPI["ocr"]> | undefined {
  return window.electronAPI?.ocr;
}

const DEVICE_LABEL: Record<string, string> = {
  auto: "Automatic",
  webgpu: "GPU",
  cpu: "CPU",
};

export function OcrSettings(): React.JSX.Element {
  const [models, setModels] = useState<UiOcrModel[]>([]);
  const [cfg, setCfg] = useState<OcrConfig | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [layout, setLayout] = useState<{
    installed: boolean;
    bytes: number;
    size: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{
    text?: string;
    error?: string;
    seconds?: number;
    device?: string;
  } | null>(null);

  const loadLayout = async (): Promise<void> => {
    const a = api();
    if (a) setLayout(await a.layoutStatus());
  };

  const load = async (): Promise<void> => {
    const a = api();
    if (!a) return;
    setModels(await a.models());
    setCfg(await a.config());
    await loadLayout();
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

  const runTest = async (path: string): Promise<void> => {
    setTesting(true);
    setTest(null);
    try {
      const r = await api()?.test(path);
      setTest(r ?? { error: "No answer from the scanner." });
    } finally {
      setTesting(false);
    }
  };

  const pickFile = async (): Promise<void> => {
    const path = await api()?.pickFile();
    if (path) void runTest(path);
  };

  const installedSomething = models.some((m) =>
    m.variants.some((v) => v.installed),
  );

  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-base font-semibold">OCR Scanner</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Most chat models read text and nothing else — hand one a scanned
          contract, a paper full of formulas or a screenshot and it is guessing.
          The scanner is a small vision model that runs <em>on this machine</em>
          : it turns a PDF page, a photo or a screenshot into Markdown, with
          formulas as LaTeX and tables as tables, and the chat model works with
          that text. Nothing is uploaded anywhere.
        </p>
      </section>

      {models.map((m) => (
        <div key={m.id} className="rounded-lg border border-border bg-card p-3">
          {/* One header row — icon, name, state, delete — and everything
              else full width beneath it, the way "How it runs" is laid out.
              The first cut nested the body inside a middle column and the
              variants ended up in a gutter. */}
          <div className="flex items-center gap-2">
            <FileScan className="size-4 shrink-0 text-brand" />
            <span className="text-sm font-medium">{m.label}</span>
            {cfg?.modelId === m.id && installedSomething && (
              <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-normal text-brand">
                in use
              </span>
            )}
            {m.variants.some((v) => v.installed || v.onDisk > 0) && (
              <button
                type="button"
                title="Delete this model's files"
                onClick={() => void api()?.remove(m.id).then(() => load())}
                className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>

          <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
            {m.note}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Languages: {m.languages}
          </p>

          <div className="mt-2 space-y-1.5">
            {m.variants.map((v) => {
              const busy =
                progress?.modelId === m.id && progress?.dtype === v.dtype;
              return (
                <div
                  key={v.dtype}
                  className={cn(
                    "rounded-md border border-border px-2.5 py-2",
                    cfg?.dtype === v.dtype &&
                      cfg?.modelId === m.id &&
                      v.installed &&
                      "border-brand/40 bg-brand/[0.04]",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px]">{v.dtype}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {v.size} · runs on {v.devices.map((d) => DEVICE_LABEL[d] ?? d).join(" and ")}
                    </span>
                    <div className="ml-auto flex items-center gap-1">
                      {v.installed && !busy && (
                        <>
                          {!(cfg?.modelId === m.id && cfg?.dtype === v.dtype) && (
                            <button
                              type="button"
                              onClick={() =>
                                void patch({ modelId: m.id, dtype: v.dtype })
                              }
                              className="rounded-md border border-border px-2 py-1 text-[11px] font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                            >
                              Use this
                            </button>
                          )}
                          <span className="text-[11px] text-muted-foreground">
                            installed
                          </span>
                        </>
                      )}
                      {!v.installed && !busy && (
                        <button
                          type="button"
                          onClick={() => void api()?.install(m.id, v.dtype)}
                          className="flex items-center gap-1 rounded-md bg-foreground px-2 py-1 text-[11px] font-medium text-background transition-opacity hover:opacity-90"
                        >
                          <Download className="size-3" />
                          Download {v.size}
                        </button>
                      )}
                      {busy && (
                        <button
                          type="button"
                          onClick={() => void api()?.cancelInstall(m.id, v.dtype)}
                          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] transition-colors hover:bg-destructive/10 hover:text-destructive"
                        >
                          <X className="size-3" />
                          Stop
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {v.note}
                  </p>
                  {busy && progress && (
                    <div className="mt-1.5">
                      <div className="h-1 overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.1]">
                        <div
                          className="h-full bg-brand transition-[width]"
                          style={{ width: `${progress.percent}%` }}
                        />
                      </div>
                      <p className="mt-1 truncate text-[11px] text-muted-foreground">
                        {progress.percent}% ·{" "}
                        {Math.round(progress.loaded / 1024 / 1024)} of{" "}
                        {Math.round(progress.total / 1024 / 1024)} MB
                        {progress.file ? ` · ${progress.file}` : ""}
                      </p>
                    </div>
                  )}
                  {!busy && !v.installed && v.onDisk > 0 && (
                    <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                      {Math.round(v.onDisk / 1024 / 1024)} MB already
                      downloaded — starting again resumes from there.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {layout && (
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-2">
            <LayoutTemplate className="size-4 shrink-0 text-brand" />
            <span className="text-sm font-medium">Block finder</span>
            {layout.installed ? (
              <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] text-brand">
                installed
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void api()?.installLayout().then(() => loadLayout())}
                className="ml-auto flex items-center gap-1 rounded-md bg-foreground px-2 py-1 text-[11px] font-medium text-background transition-opacity hover:opacity-90"
              >
                <Download className="size-3" />
                Download {layout.size}
              </button>
            )}
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
            Finds the pieces of a page — paragraphs, formulas, tables, figures
            — before anything reads them, so each is read on its own. On a page
            of coursework here that turned four minutes into twenty seconds,
            and it is what lets a formula be asked for LaTeX, a table for a
            table, and a photograph be skipped instead of described. Without
            it, pages are read whole and slowly.
          </p>
          {progress?.modelId === "layout" && (
            <div className="mt-1.5">
              <div className="h-1 overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.1]">
                <div
                  className="h-full bg-brand transition-[width]"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {progress.percent}% · {Math.round(progress.loaded / 1024 / 1024)} of{" "}
                {Math.round(progress.total / 1024 / 1024)} MB
              </p>
            </div>
          )}
        </div>
      )}

      {cfg && (
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Cpu className="size-4 text-muted-foreground" />
            How it runs
          </div>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <label className="text-[13px]">
              <span className="text-muted-foreground">Compute on</span>
              <select
                value={cfg.device}
                onChange={(e) => void patch({ device: e.target.value as OcrConfig["device"] })}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px] outline-none focus:border-brand"
              >
                <option value="auto">Automatic — GPU, then CPU</option>
                <option value="webgpu">GPU only</option>
                <option value="cpu">CPU only</option>
              </select>
              <span className="mt-1 block text-[11px] text-muted-foreground">
                Automatic tries the GPU and quietly falls back — some drivers
                take the GPU down rather than admit they cannot run a model.
              </span>
            </label>
            <label className="text-[13px]">
              <span className="text-muted-foreground">
                Resolution — {cfg.dpi} DPI
              </span>
              <input
                type="range"
                min={100}
                max={220}
                step={10}
                value={cfg.dpi}
                onChange={(e) => void patch({ dpi: Number(e.target.value) })}
                className="mt-2 w-full accent-brand"
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                Lower is faster; below ~130 the subscripts in formulas start to
                go. 150 is the default for a reason.
              </span>
            </label>
            <label className="text-[13px]">
              <span className="text-muted-foreground">
                Pages per scan — {cfg.maxPages}
              </span>
              <input
                type="range"
                min={1}
                max={200}
                step={1}
                value={cfg.maxPages}
                onChange={(e) => void patch({ maxPages: Number(e.target.value) })}
                className="mt-2 w-full accent-brand"
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                A hard stop, so "read this book" cannot become an afternoon.
              </span>
            </label>
          </div>
        </div>
      )}

      {installedSomething && (
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Try it on a file</span>
            <button
              type="button"
              disabled={testing}
              onClick={() => void pickFile()}
              className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-black/[0.04] disabled:opacity-50 dark:hover:bg-white/[0.05]"
            >
              {testing && <Loader2 className="size-3 animate-spin" />}
              {testing ? "Reading…" : "Pick a PDF or image"}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Reads the first page and times it — the only honest benchmark is
            your own document on your own machine.
          </p>
          {test?.error && (
            <p className="mt-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-[12px] text-amber-600 dark:text-amber-400">
              {test.error}
            </p>
          )}
          {test?.text && (
            <div className="mt-2">
              <p className="text-[11px] text-muted-foreground">
                One page in {test.seconds}s on the {test.device}.
              </p>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.03] p-2.5 font-mono text-[11px] leading-relaxed dark:bg-white/[0.04]">
                {test.text}
              </pre>
            </div>
          )}
        </div>
      )}

      <section className="rounded-lg bg-black/[0.03] p-3 text-[12px] leading-relaxed text-muted-foreground dark:bg-white/[0.04]">
        <p>
          <span className="font-medium text-foreground">How the agent uses it:</span>{" "}
          it calls <span className="font-mono">OCRScan</span> with a file and a
          page range and gets Markdown back. Reading a page takes real time —
          a minute or two on a laptop GPU, longer on a CPU — so for anything
          past a page or two the agent is told to hand the job to a background
          agent and keep talking to you. The result is ordinary text: it can go
          into a note, a summary, or an answer.
        </p>
      </section>
    </div>
  );
}
