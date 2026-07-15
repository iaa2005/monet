/**
 * Monet background toggle: click "Monet" in the header → random painting
 * wallpaper; click again → turn off. Right-click → auto-rotate interval.
 * Picks a random horizontal painting, fetches as data URL, applies as background.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const JSON_URL =
  "https://raw.githubusercontent.com/iaa2005/monet-paintings/main/monet_paintings.json";
const LS_KEY = "monet.background";
const LS_ROTATE = "monet.rotate";

// ══ Config ═══════════════════════════════════════════════════════════════
export const BG_AR_MIN = 4 / 3;       // min aspect ratio (width/height)
export const BG_AR_MAX = 2;           // max aspect ratio
export const BG_OPACITY = 0.2;        // painting transparency
export const BG_MIN_PX = 1_700_000;   // min resolution in pixels (width × height)

export const ROTATE_OPTIONS: { label: string; ms: number | null }[] = [
  { label: "Off", ms: null },
  { label: "1 min", ms: 60_000 },
  { label: "5 min", ms: 5 * 60_000 },
  { label: "15 min", ms: 15 * 60_000 },
  { label: "30 min", ms: 30 * 60_000 },
  { label: "1 hour", ms: 60 * 60_000 },
  { label: "3 hours", ms: 3 * 60 * 60_000 },
];

interface PaintingMeta {
  title: string;
  year: string;
  filename: string;
  width: number;
  height: number;
}

async function pickAndFetch(): Promise<{ dataUrl: string; title: string; year: string } | null> {
  try {
    const res = await fetch(JSON_URL);
    if (!res.ok) return null;
    const all: PaintingMeta[] = await res.json();
    const horizontals = all.filter((p) => {
      const ar = p.width / p.height;
      const px = p.width * p.height;
      return ar >= BG_AR_MIN && ar <= BG_AR_MAX && px >= BG_MIN_PX;
    });
    const pool = horizontals.length > 0 ? horizontals : all;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (!pick) return null;

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = "anonymous";
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = `https://raw.githubusercontent.com/iaa2005/monet-paintings/main/${pick.filename}`;
    });

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.85), title: pick.title, year: pick.year };
  } catch {
    return null;
  }
}

export function useMonetBackground(): {
  bg: string | null;
  title: string | null;
  year: string | null;
  toggle: () => void;
  rotateMs: number | null;
  setRotateMs: (ms: number | null) => void;
} {
  const [bg, setBg] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [year, setYear] = useState<string | null>(null);
  const [rotateMs, setRotateMsState] = useState<number | null>(() => {
    try {
      const v = localStorage.getItem(LS_ROTATE);
      return v ? Number(v) || null : null;
    } catch {
      return null;
    }
  });
  const rotateRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const applyBg = useCallback((dataUrl: string, t: string, y: string) => {
    setBg(dataUrl);
    setTitle(t);
    setYear(y);
    localStorage.setItem(LS_KEY, JSON.stringify({ bg: dataUrl, title: t, year: y }));
  }, []);

  const pickAndSet = useCallback(async (): Promise<void> => {
    const result = await pickAndFetch();
    if (result) applyBg(result.dataUrl, result.title, result.year);
  }, [applyBg]);

  const clear = useCallback((): void => {
    setBg(null);
    setTitle(null);
    setYear(null);
    localStorage.removeItem(LS_KEY);
  }, []);

  const toggle = useCallback((): void => {
    if (bg) {
      clear();
    } else {
      void pickAndSet();
    }
  }, [bg, clear, pickAndSet]);

  const setRotateMs = useCallback((ms: number | null) => {
    setRotateMsState(ms);
    if (ms) {
      localStorage.setItem(LS_ROTATE, String(ms));
    } else {
      localStorage.removeItem(LS_ROTATE);
    }
  }, []);

  // Sync rotateRef
  useEffect(() => {
    rotateRef.current = rotateMs;
  }, [rotateMs]);

  // Auto-rotate timer
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (!rotateMs) return;

    intervalRef.current = setInterval(() => {
      void pickAndFetch().then((result) => {
        if (result) applyBg(result.dataUrl, result.title, result.year);
      });
    }, rotateMs);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [rotateMs, applyBg]);

  // Restore from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { bg: string; title: string; year?: string };
        if (saved.bg) {
          setBg(saved.bg);
          setTitle(saved.title);
          setYear(saved.year ?? "");
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  return { bg, title, year, toggle, rotateMs, setRotateMs };
}
