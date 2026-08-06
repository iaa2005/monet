/**
 * `![[picture.png]]` — drawn, not spelled out.
 *
 * An embed is how a vault holds anything that is not prose, so a note read
 * in this app must show the picture the way Obsidian shows it. The file is
 * resolved by name through main (attachments are not in the note index —
 * they are not notes) and then read as bytes, because the vault lives
 * outside the app's data folder and `file://` is not loadable from the
 * renderer under this app's CSP.
 *
 * Big media is not inlined twice: the object URL is created once per path
 * and revoked on unmount, and anything that is not image/video/audio stays
 * a link — an embedded .zip renders as nothing anywhere.
 */

import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
};

function b64ToBlobUrl(b64: string, mime: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

export function VaultEmbed({ name }: { name: string }): JSX.Element {
  const [state, setState] = useState<{
    kind: string;
    url?: string;
    path?: string;
  } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let created: string | null = null;
    void (async () => {
      const r = await api()?.obsidian.resolveAttachment(name);
      if (!alive) return;
      if (!r?.ok || !r.path) {
        setFailed(true);
        return;
      }
      const kind = r.kind ?? "file";
      if (kind === "file") {
        setState({ kind, path: r.path });
        return;
      }
      const ext = r.path.split(".").pop()?.toLowerCase() ?? "";
      const bytes = await api()?.files.readBytes(r.path);
      if (!alive) return;
      if (!bytes?.ok || !bytes.base64) {
        setState({ kind: "file", path: r.path });
        return;
      }
      created = b64ToBlobUrl(bytes.base64, MIME[ext] ?? "application/octet-stream");
      setState({ kind, url: created, path: r.path });
    })();
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [name]);

  // A missing attachment reads like a dead wikilink: grey, named, quiet.
  if (failed)
    return (
      <span
        title={`![[${name}]] — no such file in the vault`}
        className="rounded-[4px] bg-black/[0.05] px-1 py-px text-[0.95em] text-muted-foreground dark:bg-white/[0.07]"
      >
        {name}
      </span>
    );
  if (!state)
    return <span className="text-[0.95em] text-muted-foreground">{name}</span>;

  const open = (): void => {
    if (state.path) void api()?.shell.openPath(state.path);
  };

  if (state.kind === "image" && state.url)
    return (
      <img
        src={state.url}
        alt={name}
        title={name}
        onClick={open}
        className="my-2 max-h-[28rem] max-w-full cursor-zoom-in rounded-lg border border-border object-contain"
      />
    );
  if (state.kind === "video" && state.url)
    return (
      <video
        src={state.url}
        controls
        className="my-2 max-h-[28rem] max-w-full rounded-lg border border-border"
      />
    );
  if (state.kind === "audio" && state.url)
    return <audio src={state.url} controls className="my-2 w-full max-w-md" />;

  return (
    <button
      type="button"
      onClick={open}
      title={state.path}
      className="my-1 inline-flex items-center gap-1.5 rounded-md bg-brand/10 px-1.5 py-0.5 text-[0.9em] font-medium text-brand hover:bg-brand/15"
    >
      <FileText className="size-3.5" />
      {name}
    </button>
  );
}
