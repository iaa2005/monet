/**
 * Settings → General → Profile, Claude.ai-style rows: Avatar / Full name /
 * What should Claude call you / What best describes your work / Instructions.
 * Everything autosaves; name+work+instructions are injected into every chat's
 * system prompt. The avatar can be uploaded, or picked from a FULL-SCREEN
 * carousel of Monet paintings (iaa2005/monet-paintings): hovering darkens the
 * painting except the detected-face circles (bbox), click a circle to use
 * that face as the avatar.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Palette, Upload, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ElectronAPI, PaintingInfo } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

const ROW_INPUT =
  "w-64 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-foreground/20";

const WORK_OPTIONS = [
  "", "Engineering", "Student", "Research", "Design", "Writing", "Data", "Other",
];

/** Module-level on purpose: defining this inside ProfileSection would create a
 * NEW component type every render — React remounts the row and the input
 * loses focus after every keystroke. */
function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-3.5 last:border-b-0">
      <span className="text-sm">{label}</span>
      {children}
    </div>
  );
}

/** The circle shown over a detected face = the region the avatar crop actually
 * covers: side = max(w,h) × 4.2 (the generator's face×3×1.4 padding), the
 * square clamped/shifted into the painting like detect_faces.py does. */
function faceCircle(
  p: PaintingInfo,
  f: PaintingInfo["faces"][number],
): { cx: number; cy: number; r: number } {
  const side = Math.max(f.bbox.w, f.bbox.h) * 4.2;
  const fx = f.bbox.x + f.bbox.w / 2;
  const fy = f.bbox.y + f.bbox.h / 2;
  let x1 = Math.max(0, fx - side / 2);
  let y1 = Math.max(0, fy - side / 2);
  const x2 = Math.min(p.width, x1 + side);
  const y2 = Math.min(p.height, y1 + side);
  x1 = Math.max(0, x2 - side);
  y1 = Math.max(0, y2 - side);
  return {
    cx: (x1 + x2) / 2,
    cy: (y1 + y2) / 2,
    r: Math.min(x2 - x1, y2 - y1) / 2,
  };
}

// ── Full-screen Monet painting picker ─────────────────────────────────────

function MonetPicker({
  onPicked,
  onClose,
}: {
  onPicked: () => void;
  onClose: () => void;
}): JSX.Element {
  const [paintings, setPaintings] = useState<PaintingInfo[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [img, setImg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api()
      ?.profile.paintings()
      .then((r) => {
        if (r.ok && r.items?.length) setPaintings(r.items);
        else setError(r.error ?? "No paintings with faces found.");
      })
      .catch(() => setError("Network error."));
  }, []);

  const cur = paintings?.[idx] ?? null;

  useEffect(() => {
    if (!cur) return;
    let alive = true;
    setImg(null);
    void api()
      ?.profile.paintingImage(cur.file)
      .then((r) => {
        if (alive) {
          if (r.ok && r.dataUrl) setImg(r.dataUrl);
          else setError(r.error ?? "Failed to load the painting.");
        }
      });
    return () => {
      alive = false;
    };
  }, [cur?.file]);

  const step = useCallback(
    (d: number): void => {
      if (!paintings) return;
      setError(null);
      setIdx((i) => (i + d + paintings.length) % paintings.length);
    },
    [paintings],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") step(1);
      if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, step]);

  const pick = async (file: string): Promise<void> => {
    setBusy(true);
    try {
      const r = await api()?.profile.pickPaintingFace(file);
      if (r?.ok) {
        onPicked();
        onClose();
      } else setError(r?.error ?? "Failed to set the avatar.");
    } finally {
      setBusy(false);
    }
  };

  // The dark veil covers the painting EXCEPT the face circles: one evenodd
  // path (full rect + circle subpaths) in painting-pixel coordinates.
  const veil = (p: PaintingInfo): string => {
    let d = `M0 0 H${p.width} V${p.height} H0 Z`;
    for (const f of p.faces) {
      const { cx, cy, r } = faceCircle(p, f);
      d += ` M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
    }
    return d;
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90">
      <div className="flex items-center justify-between px-4 py-3 text-white/90">
        <div className="min-w-0 text-sm">
          {cur ? (
            <>
              <span className="font-serif font-semibold">{cur.title}</span>
              {cur.year && <span className="text-white/60"> · {cur.year}</span>}
              <span className="ml-3 text-white/50">
                {idx + 1} / {paintings?.length ?? 0} · hover the painting, click
                a circle to use that face
              </span>
            </>
          ) : (
            <span>{error ?? "Loading Monet paintings…"}</span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 text-white/80 transition-colors hover:bg-white/10"
        >
          <X className="size-5" />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-14 pb-6">
        <button
          type="button"
          onClick={() => step(-1)}
          className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
        >
          <ChevronLeft className="size-6" />
        </button>

        {cur && img ? (
          <svg
            viewBox={`0 0 ${cur.width} ${cur.height}`}
            className="group max-h-full max-w-full rounded-lg shadow-2xl"
            style={{ aspectRatio: `${cur.width} / ${cur.height}` }}
          >
            <image href={img} width={cur.width} height={cur.height} />
            {/* Darken on hover — except the face circles (evenodd holes). */}
            <path
              d={veil(cur)}
              fill="rgba(0,0,0,0.6)"
              fillRule="evenodd"
              className="pointer-events-none opacity-0 transition-opacity duration-200 group-hover:opacity-100"
            />
            {cur.faces.map((f, i) => {
              const { cx, cy, r } = faceCircle(cur, f);
              return (
                <g key={i}>
                  <circle
                    cx={cx}
                    cy={cy}
                    r={r}
                    fill="none"
                    stroke="white"
                    strokeWidth={Math.max(2, cur.width / 400)}
                    className="opacity-0 transition-opacity duration-200 group-hover:opacity-90"
                  />
                  <circle
                    cx={cx}
                    cy={cy}
                    r={r}
                    fill="transparent"
                    className={cn("cursor-pointer", busy && "pointer-events-none")}
                    onClick={() => void pick(f.file)}
                  >
                    <title>Use this face as your avatar</title>
                  </circle>
                </g>
              );
            })}
          </svg>
        ) : (
          <div className="text-sm text-white/60">
            {error ?? "Loading painting…"}
          </div>
        )}

        <button
          type="button"
          onClick={() => step(1)}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
        >
          <ChevronRight className="size-6" />
        </button>
      </div>
    </div>,
    document.body,
  );
}

// ── Profile rows ──────────────────────────────────────────────────────────

export function ProfileSection(): JSX.Element {
  const [name, setName] = useState("");
  const [fullName, setFullName] = useState("");
  const [work, setWork] = useState("");
  const [about, setAbout] = useState("");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api()
      ?.profile.get()
      .then((p) => {
        setName(p.name);
        setAbout(p.about);
        setFullName(p.fullName ?? "");
        setWork(p.work ?? "");
        setAvatar(p.avatarDataUrl);
      });
  }, []);

  const persist = async (patch: {
    name?: string;
    about?: string;
    fullName?: string;
    work?: string;
  }): Promise<void> => {
    await api()?.profile.set(patch);
    setNotice("Saved ✓");
    setTimeout(() => setNotice(null), 2000);
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

  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h3 className="text-base font-semibold">Profile</h3>
        {notice && (
          <span className="text-xs text-muted-foreground">{notice}</span>
        )}
      </div>

      <div className="mt-1">
        <Row label="Avatar">
          <div className="relative">
            <button
              type="button"
              title="Change avatar"
              onClick={() => setMenuOpen((o) => !o)}
              className="block overflow-hidden rounded-full border border-border transition-transform hover:scale-105"
            >
              {avatar ? (
                <img src={avatar} alt="avatar" className="size-11 object-cover" />
              ) : (
                <div className="flex size-11 items-center justify-center bg-muted text-sm font-semibold text-muted-foreground">
                  {(name.trim()[0] ?? "?").toUpperCase()}
                </div>
              )}
            </button>
            {menuOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setMenuOpen(false)}
                />
                <div className="absolute right-0 z-20 mt-1 w-56 rounded-xl border border-border bg-card p-1 shadow-lg">
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      fileRef.current?.click();
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                  >
                    <Upload className="size-4 text-muted-foreground" />
                    Upload an image…
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      setPickerOpen(true);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                  >
                    <Palette className="size-4 text-muted-foreground" />
                    From Monet's paintings…
                  </button>
                </div>
              </>
            )}
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
        </Row>

        <Row label="Full name">
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            onBlur={() => void persist({ fullName })}
            placeholder="Aleksandr Ivanov"
            className={ROW_INPUT}
          />
        </Row>

        <Row label="What should Claude call you?">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void persist({ name })}
            placeholder="Aleksandr"
            className={ROW_INPUT}
          />
        </Row>

        <Row label="What best describes your work?">
          <select
            value={work}
            onChange={(e) => {
              setWork(e.target.value);
              void persist({ work: e.target.value });
            }}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none"
          >
            {WORK_OPTIONS.map((w) => (
              <option key={w} value={w}>
                {w || "Select"}
              </option>
            ))}
          </select>
        </Row>

        <div className="py-3.5">
          <div className="text-sm">Instructions for Claude</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Claude will keep these in mind across chats (injected into every
            chat's system prompt).
          </p>
          <textarea
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            onBlur={() => void persist({ about })}
            rows={4}
            placeholder="e.g. ask clarifying questions before giving detailed answers"
            className="mt-2 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-foreground/20"
          />
        </div>
      </div>

      {pickerOpen && (
        <MonetPicker
          onPicked={() => void refreshAvatar()}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </section>
  );
}
