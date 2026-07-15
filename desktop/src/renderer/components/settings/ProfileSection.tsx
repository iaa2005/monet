/**
 * Settings → General → Profile: name, avatar (upload or Monet-faces gallery
 * from github.com/iaa2005/monet-paintings) and an "about me" prompt injected
 * into every chat's system prompt.
 */
import { useEffect, useRef, useState } from "react";
import { Upload, Palette } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

const INPUT =
  "mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-foreground/20";

export function ProfileSection(): JSX.Element {
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [gallery, setGallery] = useState<{ url: string; dataUrl: string }[] | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api()
      ?.profile.get()
      .then((p) => {
        setName(p.name);
        setAbout(p.about);
        setAvatar(p.avatarDataUrl);
      });
  }, []);

  const save = async (): Promise<void> => {
    await api()?.profile.set({ name, about });
    setNotice("Saved ✓");
    setTimeout(() => setNotice(null), 2500);
  };

  const refreshAvatar = async (): Promise<void> => {
    const p = await api()?.profile.get();
    if (p) setAvatar(p.avatarDataUrl);
  };

  const upload = async (f: File): Promise<void> => {
    const path = api()?.getPathForFile?.(f);
    if (!path) return;
    const r = await api()?.profile.setAvatarFile(path);
    if (r?.ok) await refreshAvatar();
  };

  const openGallery = async (): Promise<void> => {
    setGalleryOpen((o) => !o);
    if (!gallery) {
      setBusy(true);
      setGalleryError(null);
      try {
        const r = await api()?.profile.gallery();
        setGallery(r?.ok ? (r.items ?? []) : []);
        if (!r?.ok) setGalleryError(r?.error ?? "Unknown error");
        else if (r.items?.length === 0) setGalleryError("No avatars loaded — check your network connection.");
      } catch {
        setGallery([]);
        setGalleryError("Network error — check your connection or VPN.");
      } finally {
        setBusy(false);
      }
    }
  };

  const pick = async (url: string): Promise<void> => {
    const r = await api()?.profile.setAvatarUrl(url);
    if (r?.ok) {
      await refreshAvatar();
      setGalleryOpen(false);
    }
  };

  return (
    <section>
      <h3 className="text-base font-semibold">Profile</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">
        The agent knows your name and preferences in every chat.
      </p>

      <div className="mt-4 flex items-start gap-4">
        <div className="flex flex-col items-center gap-2">
          {avatar ? (
            <img
              src={avatar}
              alt="avatar"
              className="size-16 rounded-full border border-border object-cover"
            />
          ) : (
            <div className="flex size-16 items-center justify-center rounded-full border border-border bg-muted text-lg font-semibold text-muted-foreground">
              {(name.trim()[0] ?? "?").toUpperCase()}
            </div>
          )}
          <div className="flex gap-1">
            <button
              type="button"
              title="Upload an image"
              onClick={() => fileRef.current?.click()}
              className="rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.05]"
            >
              <Upload className="size-3.5" />
            </button>
            <button
              type="button"
              title="Pick a face from Monet's paintings"
              onClick={() => void openGallery()}
              className={cn(
                "rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.05]",
                galleryOpen && "bg-black/[0.06] text-foreground dark:bg-white/[0.08]",
              )}
            >
              <Palette className="size-3.5" />
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = "";
            }}
          />
        </div>

        <div className="min-w-0 flex-1">
          <label className="text-sm font-medium">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What should Claude call you?"
            className={INPUT}
          />
          <label className="mt-3 block text-sm font-medium">About you</label>
          <textarea
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            rows={3}
            placeholder="Кто ты, чем занимаешься, как отвечать (язык, стиль, что учитывать)…"
            className={cn(INPUT, "resize-none")}
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              className="rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
            >
              Save
            </button>
            {notice && (
              <span className="text-xs text-muted-foreground">{notice}</span>
            )}
          </div>
        </div>
      </div>

      {galleryOpen && (
        <div className="mt-4 rounded-xl border border-border p-3">
          <div className="mb-2 text-xs text-muted-foreground">
            Faces from Claude Monet's paintings —{" "}
            <span className="font-mono">iaa2005/monet-paintings</span>
          </div>
          {busy && <p className="text-xs text-muted-foreground">Loading…</p>}
          {gallery && gallery.length === 0 && !busy && (
            <p className="text-xs text-destructive">
              {galleryError || "Couldn't load the gallery (repo unreachable?)."}
            </p>
          )}
          <div className="grid grid-cols-6 gap-2 sm:grid-cols-9">
            {gallery?.map((g) => (
              <button
                key={g.url}
                type="button"
                onClick={() => void pick(g.url)}
                className="overflow-hidden rounded-full border border-border transition-transform hover:scale-105"
                title="Use as avatar"
              >
                <img src={g.dataUrl} alt="" className="aspect-square w-full object-cover" />
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
