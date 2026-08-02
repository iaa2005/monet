/**
 * Reading an artifact's picture, and naming its type — the parts of the file
 * cards that are not themselves cards.
 *
 * They sat in FileCard, which made that file export components AND plain
 * functions AND hooks. React Fast Refresh cannot hot-update a module like
 * that ("export is incompatible") and falls back to a full page reload, so
 * every edit to a card threw the conversation on screen away. Splitting the
 * non-components out makes both halves refreshable.
 */

import { useEffect, useRef, useState } from "react";
import type { ArtifactItem } from "@/lib/sessionArtifacts";
import { pdfThumbnail } from "@/lib/pdfThumb";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/** The artifact's image as a data URL, re-read from disk when the in-memory
 * one is gone (chat switch / reload). null until/unless one is available. */
export function useArtifactImage(a: {
  dataUrl?: string;
  path?: string;
  mediaType: string;
}): string | null {
  const [url, setUrl] = useState<string | null>(a.dataUrl ?? null);

  useEffect(() => {
    if (url || !a.path) return;
    let alive = true;
    void api()
      ?.artifacts.readImage(a.path, a.mediaType)
      .then((r) => {
        if (alive && r.ok && r.dataUrl) setUrl(r.dataUrl);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.path]);

  return url;
}

/** Page 1 of a PDF, rendered once and cached by `key`. null key = not a PDF,
 * or nothing to read it from. */
export function usePdfThumb(
  key: string | null,
  load: () => Promise<Uint8Array | null>,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  // The loader closes over props and is a new function every render; keep it
  // out of the effect's deps or the render would restart on every tick.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!key) return;
    let alive = true;
    void pdfThumbnail(key, () => loadRef.current()).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [key]);

  return url;
}

export function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Human category for an extension. Only the families worth naming are here —
 * anything else shows its bare extension, which reads better than inventing a
 * label ("TEX" beats "Text · TEX"). */
const FAMILY: Record<string, string> = {
  pdf: "Document",
  doc: "Document",
  docx: "Document",
  odt: "Document",
  rtf: "Document",
  xls: "Spreadsheet",
  xlsx: "Spreadsheet",
  ods: "Spreadsheet",
  csv: "Spreadsheet",
  tsv: "Spreadsheet",
  ppt: "Presentation",
  pptx: "Presentation",
  odp: "Presentation",
  zip: "Archive",
  tar: "Archive",
  gz: "Archive",
  "7z": "Archive",
  rar: "Archive",
};

export function typeLabel(a: {
  name: string;
  mediaType: string;
  kind: ArtifactItem["kind"];
}): string {
  const ext = extOf(a.name);
  const family =
    FAMILY[ext] ??
    (a.kind === "image"
      ? "Image"
      : a.kind === "audio"
        ? "Audio"
        : a.kind === "video"
          ? "Video"
          : "");
  const tag =
    ext ? ext.toUpperCase() : (a.mediaType.split("/").pop()?.toUpperCase() ?? "FILE");
  return family ? `${family} · ${tag}` : tag;
}

/** Hand the file to the OS. */
export function openWithOS(path?: string): void {
  if (path) void api()?.artifacts.open(path);
}
