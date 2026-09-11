/**
 * The history, fitted to what the CURRENT model can take in.
 *
 * A chat outlives the model it started with. Pictures sent while a vision
 * model was active are still in the history when the user switches to a
 * text-only one — or reloads the same local model without its projector to
 * make room — and the next request carries them straight into a refusal:
 * llama.cpp answers "image input is not supported", OpenAI-compatible
 * servers 400. New attachments were already caught (chat.ts stashes what
 * the model cannot consume and hands it a note); this catches the old ones.
 *
 * Every media block the model has no modality for becomes a text block that
 * says what was there: kind, name, type, size, and that this model cannot
 * see it. The model can then say so, or ask, instead of the request dying.
 * Tool results are left alone: the OpenAI client already textifies a
 * screenshot there, and an Anthropic model always sees.
 */
import type { Modality } from "../provider/types.js";
import type { LLMContentBlock, LLMMessage } from "./adapter.js";

type Media = Extract<LLMContentBlock, { type: "image" | "audio" | "document" | "video" }>;

const NEEDS: Record<Media["type"], Modality> = {
  image: "image",
  audio: "audio",
  document: "file",
  video: "video",
};

const CANNOT: Record<Media["type"], string> = {
  image: "see images",
  audio: "hear audio",
  document: "read attached files",
  video: "watch video",
};

function isMedia(b: LLMContentBlock): b is Media {
  return b.type === "image" || b.type === "audio" || b.type === "document" || b.type === "video";
}

function sizeOf(b: Media): string {
  const bytes = Math.round((b.source.data.length * 3) / 4);
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

export function placeholderFor(b: Media): string {
  const name = "name" in b && b.name ? ` "${b.name}"` : "";
  return (
    `[${b.type}${name}, ${b.source.media_type}, ${sizeOf(b)} — attached earlier in this chat. ` +
    `The current model cannot ${CANNOT[b.type]}, so it is not included. ` +
    `Say so if it matters, or ask the user to describe it.]`
  );
}

/**
 * Same messages when every block fits; otherwise copies with the unfit
 * media replaced. `modalities` undefined means text only.
 */
export function fitToModalities(
  messages: LLMMessage[],
  modalities: readonly Modality[] | undefined,
): LLMMessage[] {
  const have = new Set<Modality>(modalities ?? ["text"]);
  let changed = false;
  const out = messages.map((m) => {
    if (typeof m.content === "string") return m;
    let touched = false;
    const content = m.content.map((b): LLMContentBlock => {
      if (!isMedia(b) || have.has(NEEDS[b.type])) return b;
      touched = true;
      return { type: "text", text: placeholderFor(b) };
    });
    if (!touched) return m;
    changed = true;
    return { ...m, content };
  });
  return changed ? out : messages;
}
