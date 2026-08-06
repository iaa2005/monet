/**
 * First-run onboarding — a full-screen intro shown once, before the app proper.
 * Presents the Code Monet brand, a few advantages, then collects the user's
 * name / a short "about you" and lets them pick an avatar from the Monet-
 * paintings gallery (same source as Settings → Profile). On finish it writes the
 * profile via the existing profile IPC and records completion in localStorage.
 *
 * Gated by App on the `monet-onboarded` flag; `onDone` unmounts it.
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, Loader2, Sparkles, Shield, Boxes, Plug } from "lucide-react";
import type { ElectronAPI } from "@/types/electron";

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

type Step = "welcome" | "profile" | "avatar";

export function OnboardingIntro({ onDone }: { onDone: () => void }): JSX.Element {
  const [step, setStep] = useState<Step>("welcome");
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [gallery, setGallery] = useState<{ url: string; dataUrl: string }[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [loadingGallery, setLoadingGallery] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load the paintings gallery lazily when the avatar step opens.
  useEffect(() => {
    if (step !== "avatar" || gallery.length > 0) return;
    setLoadingGallery(true);
    api()
      ?.profile.gallery()
      .then((r) => {
        if (r?.ok && r.items) setGallery(r.items);
      })
      .catch(() => {})
      .finally(() => setLoadingGallery(false));
  }, [step, gallery.length]);

  const finish = async (): Promise<void> => {
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
      /* best-effort — never trap the user on the intro */
    } finally {
      localStorage.setItem("monet-onboarded", "done");
      setSaving(false);
      onDone();
    }
  };

  const skip = (): void => {
    localStorage.setItem("monet-onboarded", "done");
    onDone();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-2xl px-6 py-12">
        {step === "welcome" && (
          <div className="animate-in fade-in duration-500">
            <div className="text-center">
              <h1 className="font-display text-6xl font-semibold tracking-tight text-foreground">
                Code Monet
              </h1>
              <p className="mx-auto mt-4 max-w-md text-[15px] leading-relaxed text-muted-foreground">
                A desktop AI coding agent. The power of frontier models, with a
                native desktop experience — tools, connectors and automations,
                all under your control.
              </p>
            </div>

            <div className="mt-10 grid gap-3 sm:grid-cols-2">
              {ADVANTAGES.map((a) => (
                <div
                  key={a.title}
                  className="rounded-xl border border-border bg-card/40 p-4"
                >
                  <a.icon className="size-5 text-foreground" />
                  <div className="mt-2 text-sm font-medium text-foreground">
                    {a.title}
                  </div>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                    {a.desc}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-10 flex items-center justify-between">
              <button
                type="button"
                onClick={skip}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Skip
              </button>
              <button
                type="button"
                onClick={() => setStep("profile")}
                className="inline-flex items-center gap-2 rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
              >
                Get started
                <ArrowRight className="size-4" />
              </button>
            </div>
          </div>
        )}

        {step === "profile" && (
          <div className="animate-in fade-in slide-in-from-right-4 duration-300">
            <h2 className="font-display text-3xl font-semibold tracking-tight text-foreground">
              Nice to meet you
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Tell the agent what to call you and a little about yourself. This is
              woven into its system prompt — you can change it anytime in Settings.
            </p>

            <div className="mt-8 space-y-5">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">
                  What should we call you?
                </label>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">
                  A bit about you{" "}
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </label>
                <textarea
                  value={about}
                  onChange={(e) => setAbout(e.target.value)}
                  placeholder="What you work on, how you like the agent to behave, preferred stack…"
                  rows={4}
                  className="w-full resize-none rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40"
                />
              </div>
            </div>

            <div className="mt-10 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep("welcome")}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => setStep("avatar")}
                className="inline-flex items-center gap-2 rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
              >
                Continue
                <ArrowRight className="size-4" />
              </button>
            </div>
          </div>
        )}

        {step === "avatar" && (
          <div className="animate-in fade-in slide-in-from-right-4 duration-300">
            <h2 className="font-display text-3xl font-semibold tracking-tight text-foreground">
              Pick an avatar
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Choose a Monet painting — or skip and set one later in Settings.
            </p>

            <div className="mt-6 min-h-[220px]">
              {loadingGallery ? (
                <div className="flex h-56 items-center justify-center text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              ) : gallery.length === 0 ? (
                <p className="py-16 text-center text-sm text-muted-foreground">
                  Couldn't load the gallery — you can set an avatar later in
                  Settings.
                </p>
              ) : (
                <div className="grid max-h-[46vh] grid-cols-4 gap-3 overflow-y-auto pr-1 sm:grid-cols-5">
                  {gallery.map((g) => (
                    <button
                      key={g.url}
                      type="button"
                      onClick={() => setPicked(g.url)}
                      className={
                        "relative aspect-square overflow-hidden rounded-full border-2 transition-transform hover:scale-105 " +
                        (picked === g.url
                          ? "border-foreground"
                          : "border-transparent")
                      }
                    >
                      <img
                        src={g.dataUrl}
                        alt=""
                        className="size-full object-cover"
                      />
                      {picked === g.url && (
                        <span className="absolute inset-0 flex items-center justify-center bg-black/30">
                          <Check className="size-5 text-white" />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-8 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep("profile")}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => void finish()}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
                Finish
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
