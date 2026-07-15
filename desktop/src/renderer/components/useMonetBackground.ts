/**
 * Monet background toggle: click "Monet" in the header → random painting
 * wallpaper; click again → turn off.  Picks a random horizontal painting,
 * fetches it as a data URL, and applies it as the body background.
 */
import { useCallback, useEffect, useState } from "react";

const JSON_URL =
  "https://raw.githubusercontent.com/iaa2005/monet-paintings/main/monet_paintings.json";
const LS_KEY = "monet.background";

interface PaintingMeta {
  title: string;
  year: string;
  filename: string;
  width: number;
  height: number;
}

export function useMonetBackground(): {
  bg: string | null;
  title: string | null;
  toggle: () => void;
} {
  const [bg, setBg] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);

  const pickAndSet = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(JSON_URL);
      if (!res.ok) return;
      const all: PaintingMeta[] = await res.json();
      // Prefer horizontal paintings (width >= height)
      const horizontals = all.filter((p) => p.width >= p.height);
      const pool = horizontals.length > 0 ? horizontals : all;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (!pick) return;

      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.crossOrigin = "anonymous";
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = `https://raw.githubusercontent.com/iaa2005/monet-paintings/main/${pick.filename}`;
      });

      // Draw to canvas and get data URL (avoids CORS issues with direct URL)
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);

      setBg(dataUrl);
      setTitle(pick.title);
      localStorage.setItem(LS_KEY, JSON.stringify({ bg: dataUrl, title: pick.title }));
    } catch {
      /* network error — silently ignore */
    }
  }, []);

  const clear = useCallback((): void => {
    setBg(null);
    setTitle(null);
    localStorage.removeItem(LS_KEY);
  }, []);

  const toggle = useCallback((): void => {
    if (bg) {
      clear();
    } else {
      void pickAndSet();
    }
  }, [bg, clear, pickAndSet]);

  // Restore from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { bg: string; title: string };
        if (saved.bg) {
          setBg(saved.bg);
          setTitle(saved.title);
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  return { bg, title, toggle };
}
