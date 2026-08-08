/**
 * First run — eight screens, each one thing, each skippable but the first.
 *
 * The old version was three: welcome, name, avatar. Everything else the app
 * needs to be useful — a folder, a model, a voice, a vault — was discovered
 * later, in Settings, by somebody who did not know to look. So the setup now
 * offers each of them once, in the order they matter, and gets out of the way.
 *
 * Three rules it follows, because a wizard that breaks any of them is worse
 * than no wizard:
 *
 *   - SHORT. One line of explanation per screen, never two. Anybody reading a
 *     paragraph here is reading it instead of using the app.
 *   - SKIPPABLE, one step at a time. Skip means "not this", not "none of
 *     this" — so it advances by one and nothing is remembered as refused. The
 *     welcome has no Skip at all: there is nothing on it to decline.
 *   - HONEST about progress. The bar is real: step N of the ones that remain,
 *     so somebody deciding whether to keep going can see how much is left.
 *
 * Nothing here is required. The app runs with no vault, no models and no
 * avatar — but not without a provider, which is why that screen is last: the
 * one you are most likely to finish should come after everything you might
 * abandon.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  Check,
  Download,
  ExternalLink,
  Folder,
  Loader2,
  Mic,
  Plug,
  ScanText,
  Shield,
  Sparkles,
  Volume2,
} from "lucide-react";
import type { ElectronAPI, SttModelStatus, UiVault } from "@/types/electron";
import { ObsidianIcon } from "@/components/ObsidianIcon";
import { CodeThemePicker } from "@/components/settings/CodeThemePicker";
import {
  STEPS,
  progressAt,
  stepLabel,
  type StepId,
} from "@/components/onboarding/steps";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

const ADVANTAGES = [
  {
    icon: Sparkles,
    title: "Any model, one agent",
    desc: "Claude, GPT, DeepSeek and more — bring your own provider and keep the same rich agentic workflow.",
  },
  {
    icon: Boxes,
    title: "Real tools, sandboxed",
    desc: "Run code and commands in an isolated sandbox, edit files, browse, and use the computer — safely.",
  },
  {
    icon: Plug,
    title: "Your accounts, connected",
    desc: "Mail, calendar, disk, chat and more via connectors — plus Routines that run on a schedule.",
  },
  {
    icon: Shield,
    title: "Local & private",
    desc: "Your data and transcripts live on your machine. You stay in control of what the agent can touch.",
  },
];

/** The one button shape used all over this screen. */
function Btn({
  onClick,
  disabled,
  busy,
  children,
  variant = "solid",
}: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  children: React.ReactNode;
  variant?: "solid" | "outline";
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={
        variant === "solid"
          ? "inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40"
          : "inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] disabled:opacity-40 dark:hover:bg-white/[0.05]"
      }
    >
      {busy && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
}

/** A download that reports itself: idle → percent → done. */
function DownloadRow({
  icon: Icon,
  label,
  note,
  installed,
  percent,
  onInstall,
}: {
  icon: typeof Mic;
  label: string;
  note: string;
  installed: boolean;
  percent: number | null;
  onInstall: () => void;
}): JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border p-3">
      <span
        aria-hidden
        className={
          installed
            ? "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/12 text-brand"
            : "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
        }
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
          {note}
        </p>
        {percent != null && !installed && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-brand transition-[width] duration-300"
              style={{ width: `${Math.round(percent)}%` }}
            />
          </div>
        )}
      </div>
      <div className="mt-0.5 shrink-0">
        {installed ? (
          <span className="inline-flex items-center gap-1 text-[13px] text-brand">
            <Check className="size-3.5" />
            Ready
          </span>
        ) : (
          <Btn variant="outline" onClick={onInstall} busy={percent != null}>
            {percent == null ? (
              <>
                <Download className="size-3.5" />
                Download
              </>
            ) : (
              `${Math.round(percent)}%`
            )}
          </Btn>
        )}
      </div>
    </div>
  );
}

export function OnboardingIntro({ onDone }: { onDone: () => void }): JSX.Element {
  const [index, setIndex] = useState(0);
  const step: StepId = STEPS[index]?.id ?? "welcome";
  const [saving, setSaving] = useState(false);

  // ── About you ──
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [gallery, setGallery] = useState<{ url: string; dataUrl: string }[]>([]);
  const [picked, setPicked] = useState<string | null>(null);

  // ── Where your data lives ──
  const [dir, setDir] = useState("");
  const [dirDefault, setDirDefault] = useState(true);
  const [dirMoved, setDirMoved] = useState(false);
  /** What was already in the folder they chose — see pickFolder. */
  const [dirFound, setDirFound] = useState<{ hasData: boolean; chats: number } | null>(
    null,
  );
  /** Rises whenever a folder is chosen, so every later step re-reads from it.
   * A counter rather than a flag: choosing twice has to re-read twice. */
  const [adopted, setAdopted] = useState(0);

  // ── How it looks ──
  const [dark, setDark] = useState(
    () => document.documentElement.classList.contains("dark"),
  );

  // ── Talking to it ──
  const [sttModels, setSttModels] = useState<SttModelStatus[]>([]);
  const [sttPct, setSttPct] = useState<number | null>(null);
  const [ttsInstalled, setTtsInstalled] = useState(false);
  const [ttsPct, setTtsPct] = useState<number | null>(null);

  // ── Reading documents ──
  const [ocrReady, setOcrReady] = useState(false);
  const [ocrPct, setOcrPct] = useState<number | null>(null);
  const [ocrTarget, setOcrTarget] = useState<{ id: string; dtype: string } | null>(
    null,
  );

  // ── Obsidian ──
  const [vaults, setVaults] = useState<UiVault[]>([]);
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);

  // ── The model ──
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  /** A provider the chosen folder already has configured. Somebody adopting
   * their own folder should be told it is done, not asked for a key again. */
  const [haveProvider, setHaveProvider] = useState<string | null>(null);

  const last = index === STEPS.length - 1;

  const finish = useCallback(async (): Promise<void> => {
    setSaving(true);
    try {
      const patch: { name?: string; about?: string; fullName?: string } = {};
      const trimmed = name.trim();
      if (trimmed) {
        patch.name = trimmed;
        patch.fullName = trimmed;
      }
      if (about.trim()) patch.about = about.trim();
      if (Object.keys(patch).length) await api()?.profile.set(patch);
      if (picked) await api()?.profile.setAvatarUrl(picked);
    } catch {
      /* best-effort — never trap somebody on the setup */
    } finally {
      // In the file, not localStorage: the flag belongs to the DATA FOLDER,
      // and localStorage is keyed by origin — which in dev carries vite's
      // port. See lib/first-run.ts.
      await api()?.settings.setUiPrefs({ onboarded: true }).catch(() => {});
      setSaving(false);
      onDone();
    }
  }, [about, name, picked, onDone]);

  const advance = (): void => {
    if (last) void finish();
    else setIndex((i) => i + 1);
  };

  // ── Loads, each when its step arrives and not before ──

  // Whatever the current data folder already knows about you.
  //
  // These fields used to start empty and only ever be written, which was fine
  // for a genuinely first run and wrong the moment somebody points the setup
  // at a folder they have been using: it offered to write a name over the one
  // already there, showing a blank box as if there were none. Keyed on
  // `adopted` so choosing a folder re-reads it.
  useEffect(() => {
    if (step !== "you") return;
    let alive = true;
    void api()
      ?.profile.get()
      .then((p) => {
        if (!alive || !p) return;
        setName((v) => v || p.name || p.fullName || "");
        setAbout((v) => v || p.about || "");
      })
      .catch(() => {});
    void api()
      ?.profile.gallery()
      .then((r) => {
        if (alive && r?.ok && r.items) setGallery(r.items);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [step, adopted]);

  useEffect(() => {
    if (step !== "folder" || dir) return;
    void api()
      ?.settings.getDataDir()
      .then((r) => {
        if (!r) return;
        setDir(r.dir);
        setDirDefault(r.isDefault);
      })
      .catch(() => {});
  }, [step, dir]);

  useEffect(() => {
    if (step !== "voice") return;
    void api()?.stt.models().then(setSttModels).catch(() => {});
    void api()
      ?.tts.status()
      .then((s) => setTtsInstalled(!!s?.installed))
      .catch(() => {});
    const offStt = api()?.stt.onModelProgress((p) => {
      setSttPct(p.done || p.error ? null : p.percent);
      if (p.done) void api()?.stt.models().then(setSttModels).catch(() => {});
    });
    const offTts = api()?.tts.onProgress((p) => {
      setTtsPct(p.percent >= 100 ? null : p.percent);
      if (p.percent >= 100)
        void api()
          ?.tts.status()
          .then((s) => setTtsInstalled(!!s?.installed))
          .catch(() => {});
    });
    return () => {
      offStt?.();
      offTts?.();
    };
  }, [step, adopted]);

  useEffect(() => {
    if (step !== "ocr") return;
    void api()
      ?.ocr.models()
      .then((list) => {
        // The recommended pair: the first model, at the smallest variant that
        // exists. A first run is not the place to explain quantisation.
        const model = list?.[0];
        const variant = model?.variants?.[0];
        if (model && variant) setOcrTarget({ id: model.id, dtype: variant.dtype });
        setOcrReady(
          !!list?.some((m) => m.variants?.some((v) => v.installed)),
        );
      })
      .catch(() => {});
    const off = api()?.ocr.onInstallProgress((p) => {
      setOcrPct(p.done || p.error ? null : p.percent);
      if (p.done) setOcrReady(true);
    });
    return () => off?.();
  }, [step]);

  useEffect(() => {
    if (step !== "provider") return;
    let alive = true;
    void api()
      ?.providers.list()
      .then((list) => {
        if (!alive) return;
        const configured = (list ?? []).find((p) => !!p.apiKey);
        setHaveProvider(configured ? configured.name : null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [step, adopted]);

  useEffect(() => {
    if (step !== "vault") return;
    void api()?.obsidian.list().then(setVaults).catch(() => {});
  }, [step, adopted]);

  // ── Actions ──

  const pickFolder = async (): Promise<void> => {
    const picked = await api()?.settings.pickDataDir();
    if (!picked) return;
    // Somebody may well be pointing at a folder that ALREADY holds their Code
    // Monet data — a new machine, a drive they keep their work on, a reinstall.
    // Nothing about the switch destroys anything either way (it writes a path;
    // it does not copy or clear), but this screen has to be able to say which
    // of the two just happened. Silently swallowing an existing library looks,
    // from the outside, exactly like losing it.
    const found = await api()?.settings.inspectDataDir(picked).catch(() => undefined);
    setDirFound(found?.hasData ? { hasData: true, chats: found.chats } : null);
    const r = await api()?.settings.setDataDir(picked);
    if (r?.ok) {
      setDir(picked);
      setDirDefault(false);
      setDirMoved(true);
      // Main has dropped its database handle and its provider list, so the
      // remaining steps now read the folder just chosen. Tell them to.
      setAdopted((n) => n + 1);
    }
  };

  const themeChoice = (wantDark: boolean): void => {
    setDark(wantDark);
    document.documentElement.classList.toggle("dark", wantDark);
    localStorage.setItem("theme", wantDark ? "dark" : "light");
  };

  const addVault = async (create: boolean): Promise<void> => {
    setVaultError(null);
    const path = await api()?.files.pickDirectory();
    if (!path) return;
    setVaultBusy(true);
    try {
      const r = await api()?.obsidian.add(path);
      if (!r?.ok) setVaultError(r?.error ?? "That folder could not be added.");
      else {
        const list = (await api()?.obsidian.list()) ?? [];
        setVaults(list);
        // An empty folder IS a new vault — Obsidian makes one the same way.
        if (create && r.vault) await api()?.obsidian.update(r.vault.id, { enabled: true });
      }
    } finally {
      setVaultBusy(false);
    }
  };

  const saveKey = async (): Promise<void> => {
    const trimmed = key.trim();
    if (!trimmed) return;
    setKeyError(null);
    setSaving(true);
    try {
      const list = (await api()?.providers.list()) ?? [];
      const or = list.find((p) => p.kind === "openrouter");
      if (or) {
        await api()?.providers.update(or.id, { apiKey: trimmed });
        await api()?.providers.setActive(or.id);
      } else {
        const added = await api()?.providers.add({
          name: "OpenRouter",
          kind: "openrouter",
          baseURL: "https://openrouter.ai/api/v1",
          apiKey: trimmed,
          model: "openrouter/free",
        } as never);
        if (added?.id) await api()?.providers.setActive(added.id);
      }
      void finish();
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "That key was not accepted.");
      setSaving(false);
    }
  };

  const spec = STEPS[index];
  const label = stepLabel(index);

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-background">
      {/* How much is left. Real, and only from the second screen — on the
          welcome there is nothing behind you to show. */}
      {index > 0 && (
        <div className="sticky top-0 z-10 bg-background/90 backdrop-blur">
          <div className="h-0.5 w-full bg-muted">
            <div
              className="h-full bg-brand transition-[width] duration-300"
              style={{ width: `${Math.round(progressAt(index) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* The title, the line under it and the counter — ABOVE the body rather
          than inside it. Inside, they moved every time a step's content was a
          different height: the theme picker is tall, the OCR row is one line,
          and the heading jumped between them. */}
      {index > 0 && (
        <div className="shrink-0 px-6 pt-10">
          <div className="mx-auto w-full max-w-2xl">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="font-display text-2xl font-semibold tracking-tight">
                {spec.title}
              </h2>
              {label && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {label}
                </span>
              )}
            </div>
            {spec.hint && (
              <p className="mt-1 text-sm text-muted-foreground">{spec.hint}</p>
            )}
          </div>
        </div>
      )}

      {/* Centred in what is left, both ways: on a tall window the setup sits
          at eye level instead of clinging to the top edge, and the buttons
          stay where they were on the previous screen — the same place on
          every one of them, at the bottom. */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-6">
        <div className="w-full max-w-2xl">
        {step === "welcome" ? (
          <div className="animate-in fade-in duration-500">
            <div className="text-left">
              <h1 className="font-display text-6xl font-semibold tracking-tight text-foreground">
                Code Monet
              </h1>
              <p className="mr-auto mt-4 max-w-md text-[15px] leading-relaxed text-muted-foreground">
                A desktop AI coding agent. The power of frontier models, with a
                native desktop experience — tools, connectors and automations,
                all under your control.
              </p>
            </div>
            <div className="mt-10 grid gap-3 sm:grid-cols-2">
              {ADVANTAGES.map((a) => (
                <div
                  key={a.title}
                  className="rounded-xl border border-border p-4 text-left"
                >
                  <a.icon className="size-4 text-brand" />
                  <div className="mt-2 text-sm font-medium">{a.title}</div>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                    {a.desc}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div key={step} className="animate-in fade-in duration-300">
            <div>
              {step === "folder" && (
                <div className="space-y-3">
                  <div className="flex items-start gap-3 rounded-xl border border-border p-3">
                    <Folder className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[13px]" title={dir}>
                        {dir || "…"}
                      </div>
                      <p className="mt-0.5 text-[13px] text-muted-foreground">
                        {dirDefault ? "The default place" : "Your choice"}
                      </p>
                    </div>
                    <Btn variant="outline" onClick={() => void pickFolder()}>
                      Choose another
                    </Btn>
                  </div>
                  {dirFound?.hasData && (
                    <p className="text-[13px] text-brand">
                      There is already Code Monet data here
                      {dirFound.chats > 0
                        ? ` — ${dirFound.chats} chat${dirFound.chats === 1 ? "" : "s"}`
                        : ""}
                      . It will be used as it is; nothing is copied or cleared.
                    </p>
                  )}
                  {dirMoved && (
                    <p className="text-[13px] text-muted-foreground">
                      Applies when the app restarts.
                    </p>
                  )}
                </div>
              )}

              {step === "you" && (
                <div className="space-y-4">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-foreground/25"
                  />
                  <textarea
                    value={about}
                    onChange={(e) => setAbout(e.target.value)}
                    placeholder="What you work on, how you like things done…"
                    rows={3}
                    className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-foreground/25"
                  />
                  {gallery.length > 0 && (
                    <div>
                      <div className="text-[13px] text-muted-foreground">
                        Pick a face — Monet, naturally.
                      </div>
                      <div className="mt-2 grid grid-cols-6 gap-2">
                        {gallery.slice(0, 12).map((g) => (
                          <button
                            key={g.url}
                            type="button"
                            onClick={() => setPicked(g.url)}
                            className={
                              picked === g.url
                                ? "aspect-square overflow-hidden rounded-full ring-2 ring-brand"
                                : "aspect-square overflow-hidden rounded-full opacity-80 transition-opacity hover:opacity-100"
                            }
                          >
                            <img
                              src={g.dataUrl}
                              alt=""
                              className="size-full object-cover"
                            />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {step === "look" && (
                <div className="space-y-4">
                  <div className="flex gap-2">
                    {([false, true] as const).map((d) => (
                      <button
                        key={String(d)}
                        type="button"
                        onClick={() => themeChoice(d)}
                        className={
                          dark === d
                            ? "flex-1 rounded-xl border-2 border-brand p-3 text-sm font-medium"
                            : "flex-1 rounded-xl border border-border p-3 text-sm transition-colors hover:border-foreground/25"
                        }
                      >
                        {d ? "Dark" : "Light"}
                      </button>
                    ))}
                  </div>
                  {/* The Settings picker itself — grids, swatches and the live
                      sample. A smaller widget here would mean choosing a
                      palette you cannot see. */}
                  <CodeThemePicker />
                </div>
              )}

              {step === "voice" && (
                <div className="space-y-2">
                  <DownloadRow
                    icon={Mic}
                    label="Dictation"
                    note="Speak instead of typing, anywhere in the app. Runs on your machine — nothing is sent anywhere."
                    installed={sttModels.some((m) => m.installed)}
                    percent={sttPct}
                    onInstall={() => {
                      const first = sttModels[0];
                      if (!first) return;
                      setSttPct(0);
                      void api()?.stt.installModel(first.id);
                    }}
                  />
                  <DownloadRow
                    icon={Volume2}
                    label="Voice Mode"
                    note="Hold a conversation out loud — it listens, answers, and speaks back."
                    installed={ttsInstalled}
                    percent={ttsPct}
                    onInstall={() => {
                      setTtsPct(0);
                      void api()?.tts.install("");
                    }}
                  />
                </div>
              )}

              {step === "ocr" && (
                <DownloadRow
                  icon={ScanText}
                  label="Document scanning"
                  note="Turn a PDF or a photo of a page into text the agent can read, search and edit."
                  installed={ocrReady}
                  percent={ocrPct}
                  onInstall={() => {
                    if (!ocrTarget) return;
                    setOcrPct(0);
                    void api()?.ocr.install(ocrTarget.id, ocrTarget.dtype);
                  }}
                />
              )}

              {step === "vault" && (
                <div className="space-y-3">
                  {vaults.length > 0 ? (
                    <div className="space-y-2">
                      {vaults.map((v) => (
                        <div
                          key={v.id}
                          className="flex items-center gap-3 rounded-xl border border-border p-3"
                        >
                          <ObsidianIcon className="size-4 shrink-0 text-brand" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">
                              {v.name}
                            </div>
                            <div
                              className="truncate font-mono text-[11px] text-muted-foreground"
                              title={v.path}
                            >
                              {v.path}
                            </div>
                          </div>
                          <Check className="size-4 shrink-0 text-brand" />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[13px] text-muted-foreground">
                      Have one already? Point at its folder. Starting fresh? Pick
                      an empty folder — that is all a vault is.
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Btn
                      variant="outline"
                      busy={vaultBusy}
                      onClick={() => void addVault(false)}
                    >
                      <ObsidianIcon className="size-3.5" />
                      {vaults.length ? "Add another" : "Choose a folder"}
                    </Btn>
                  </div>
                  {vaultError && (
                    <p className="text-[13px] text-destructive">{vaultError}</p>
                  )}
                </div>
              )}

              {step === "provider" && (
                <div className="space-y-3">
                  {haveProvider && (
                    <p className="inline-flex items-center gap-1.5 text-[13px] text-brand">
                      <Check className="size-3.5" />
                      {haveProvider} is already set up in this folder — nothing to
                      do here.
                    </p>
                  )}
                  <p className="text-[13px] leading-relaxed text-muted-foreground">
                    OpenRouter gives away free models. Make a key, paste it here,
                    and you are working.
                  </p>
                  {/* The OS browser, not the app's own panel: that panel lives
                      BEHIND this full-screen overlay, so a link that opened
                      there looked like a link that did nothing. And signing in
                      to OpenRouter belongs in the browser you already trust. */}
                  <div className="flex flex-wrap gap-3 text-[13px]">
                    {[
                      {
                        url: "https://openrouter.ai/workspaces/default/keys",
                        label: "Get a key",
                      },
                      {
                        url: "https://openrouter.ai/openrouter/free",
                        label: "See the free models",
                      },
                    ].map((l) => (
                      <button
                        key={l.url}
                        type="button"
                        onClick={() => void api()?.shell.openExternal(l.url)}
                        className="inline-flex items-center gap-1 text-brand hover:underline"
                      >
                        {l.label}
                        <ExternalLink className="size-3" />
                      </button>
                    ))}
                  </div>
                  <input
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveKey();
                    }}
                    placeholder="sk-or-…"
                    spellCheck={false}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-foreground/25"
                  />
                  {keyError && (
                    <p className="text-[13px] text-destructive">{keyError}</p>
                  )}
                  <p className="text-[13px] text-muted-foreground">
                    Any other provider works too — Settings → Providers.
                  </p>
                </div>
              )}
            </div>

          </div>
        )}
        </div>
      </div>

      {/* One footer, the same on every screen: back on the left, forward on
          the right, both always in the same place. There is no Skip — nothing
          here is required, so Continue already is one, and a second button
          that does the same thing only asks people to choose between them. */}
      <div className="shrink-0 border-t border-border px-6 py-4">
        <div className="mx-auto flex w-full max-w-2xl items-center">
          {index > 0 ? (
            <button
              type="button"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              Back
            </button>
          ) : (
            <span />
          )}
          <div className="ml-auto flex items-center gap-3">
            {last && (
              <button
                type="button"
                onClick={() => void finish()}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                Later, in Settings
              </button>
            )}
            {step === "welcome" ? (
              <Btn onClick={advance}>
                Set it up
                <ArrowRight className="size-4" />
              </Btn>
            ) : step === "provider" ? (
              haveProvider && !key.trim() ? (
                <Btn onClick={() => void finish()} busy={saving}>
                  Start
                  <ArrowRight className="size-4" />
                </Btn>
              ) : (
                <Btn onClick={() => void saveKey()} busy={saving} disabled={!key.trim()}>
                  Save the key and start
                </Btn>
              )
            ) : (
              <Btn onClick={advance} busy={saving}>
                Continue
                <ArrowRight className="size-4" />
              </Btn>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
