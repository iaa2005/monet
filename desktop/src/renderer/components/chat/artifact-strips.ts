/**
 * Which artifacts belong to which turn, and WHEN they are allowed to show.
 *
 * A turn can produce files from several tools — a script writes one, a
 * screenshot lands, a sandbox write adds another. They are collected per
 * turn and drawn as one strip after the turn's last message, the way the
 * official app puts a document card under the reply that made it.
 *
 * The timing is the part worth having its own file. The strip used to
 * appear DURING generation, growing an item at a time while the answer was
 * still being written, and every addition pushed the text the reader was
 * in the middle of. So a running turn gets no strip: it lands once, when
 * the turn is over. "Over" includes ending in an error — a failed turn
 * stops streaming too, and whatever it did produce is still worth having.
 */

import type { ChatMessage } from "@/types/chat";
import {
  sandboxFilesFromOutput,
  type ArtifactItem,
} from "@/lib/sessionArtifacts";

/**
 * @param streaming the last turn is still running
 * @returns message index -> the strip to draw after it
 */
export function stripIndexes(
  msgs: ChatMessage[],
  streaming: boolean,
): Map<number, ArtifactItem[]> {
  const strips = new Map<number, ArtifactItem[]>();
  let acc = new Map<string, ArtifactItem>(); // dedupe by name, last wins
  let lastIdx = -1;
  const flush = (): void => {
    if (acc.size > 0 && lastIdx >= 0) strips.set(lastIdx, [...acc.values()]);
    acc = new Map();
    lastIdx = -1;
  };
  msgs.forEach((m, i) => {
    if (m.role === "user") {
      flush();
      return;
    }
    lastIdx = i;
    // Any tool whose result carries [artifact] markers contributes to the
    // turn's strip (RunPython, RunCommand, Write, screenshots …).
    const out = m.toolCall?.output;
    if (out && out.includes("[artifact]"))
      for (const f of sandboxFilesFromOutput(out, m.timestamp))
        acc.set(f.name, f);
  });
  // Every turn but the running one. A finished turn was already flushed at
  // the user message that ended it; this last flush is the turn in
  // progress, and it waits.
  if (!streaming) flush();
  return strips;
}
