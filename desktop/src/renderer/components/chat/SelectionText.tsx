/**
 * A message that referred to something on a page, drawn for a person.
 *
 * The text carries two things the model needs and the reader does not: a
 * ⟨reference⟩ inline, and a block underneath describing the element down to its
 * computed styles. The block is hidden here — printed verbatim it turned a
 * two-word instruction into something that looked like a stack trace — and the
 * reference becomes a pill you can hover to see where it pointed.
 *
 * Nothing is removed from the message itself. This only decides what is drawn.
 */

import { Fragment } from "react";
import { chipColors, toneForLabel } from "@shared/selection-tones";
import {
  REF_TOKEN,
  splitSelections,
  type SelectionRef,
} from "@/lib/selection-marks";
import type { ChatAttachmentMeta } from "@/types/chat";
import { useIsDark } from "./highlight";
import { useArtifactImage } from "@/components/FileCard";
import { ChipIcon } from "./chip-icons";

/**
 * One chip. Its own component because the crop needs a hook: in a live session
 * the image is a dataUrl, but the DB stores only the artifact path — after a
 * reload the picture has to be read back from disk, or every chip silently
 * degrades to the fallback icon.
 */
function Chip({
  label,
  refHit,
  crop,
  dark,
}: {
  label: string;
  refHit?: SelectionRef;
  crop?: ChatAttachmentMeta;
  dark: boolean;
}): JSX.Element {
  // The tone the block recorded — the same slot the page outlined and the
  // composer chip used. Hashing the label is the fallback for messages
  // written before the block carried it (and it is what made a chip change
  // colour the moment it was sent).
  const c = chipColors(refHit?.tone ?? toneForLabel(label), dark);
  const thumb = useArtifactImage(
    crop ?? { mediaType: "image/png" },
  );
  return (
    <span
      title={refHit ? tooltipFor(refHit) : label}
      style={{ color: c.fg, background: c.bg }}
      className="mx-0.5 inline-flex items-center gap-1 rounded-sm pl-1 pr-1 align-baseline translate-y-1"
    >
      {/* The crop lives ON the chip: the browser tool made it, so it is part
          of the reference rather than a file anyone chose to attach. */}
      {thumb ? (
        <img
          src={thumb}
          alt=""
          className="size-4 shrink-0 rounded-[3px] object-cover"
        />
      ) : (
        <ChipIcon kind={refHit?.kind ?? "browser"} />
      )}
      {label}
    </span>
  );
}

/** The bits of a block worth showing on hover — not all forty lines of it. */
function tooltipFor(ref: SelectionRef): string {
  // Non-browser kinds carry their point in an attribute — show that.
  if (ref.kind === "code" || ref.kind === "file") {
    const path = /(?:file|path)="([^"]+)"/.exec(ref.raw)?.[1];
    const lines = /lines="([^"]+)"/.exec(ref.raw)?.[1];
    return (
      [path, lines ? `lines ${lines}` : null].filter(Boolean).join(" — ") ||
      ref.label
    );
  }
  if (ref.kind === "chat") return `Chat: ${ref.label}`;
  const keep = ["selector:", "xpath:", "source:", "text:", "likely source files:"];
  const lines = ref.raw
    .split("\n")
    .filter((l) => keep.some((k) => l.startsWith(k)));
  return [ref.url, ...lines].filter(Boolean).join("\n");
}

export function SelectionText({
  content,
  crops = [],
}: {
  content: string;
  /** Crops the browser tool made, in the order the references appear. */
  crops?: ChatAttachmentMeta[];
}): JSX.Element {
  const dark = useIsDark();
  const { text, refs } = splitSelections(content);
  if (refs.length === 0 && !REF_TOKEN.test(text)) return <>{content}</>;

  // Refs are consumed in the order their tokens appear, so a pill shows the
  // element it actually stands for when a message carries several.
  const queue = refs.map((r, i) => ({ ref: r, crop: crops[i] }));
  const byLabel = (
    label: string,
  ): { ref: SelectionRef; crop?: ChatAttachmentMeta } | undefined => {
    const at = queue.findIndex((r) => r.ref.label === label);
    return at < 0 ? undefined : queue.splice(at, 1)[0];
  };

  const parts: React.ReactNode[] = [];
  let last = 0;
  // matchAll needs a fresh index — REF_TOKEN is a module-level global regex.
  REF_TOKEN.lastIndex = 0;
  for (const m of text.matchAll(REF_TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const label = m[1] ?? "";
    const hit = byLabel(label);
    parts.push(
      <Chip
        key={`${at}-${label}`}
        label={label}
        refHit={hit?.ref}
        crop={hit?.crop}
        dark={dark}
      />,
    );
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));

  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </>
  );
}
