/**
 * Cutting a long markdown document into pieces that can be rendered one at a
 * time.
 *
 * Measured in the app: a 137 KB markdown document took 3.1 seconds of blocked
 * main thread to render, and 1.7 more every time anything in the parent
 * changed — which in the file viewer is every mouse-up. The app was simply
 * frozen after opening a big .md, which is what a user reported twice.
 *
 * The cut has one hard rule: never inside a fenced code block. A fence split
 * across two renders turns the rest of the document into code. Everything
 * else about markdown survives being rendered in pieces — a list broken at a
 * blank line looks the same, a table has no blank lines inside it — and the
 * pieces are joined back with the exact separator that was removed, so the
 * concatenation is the original document byte for byte.
 */

/** Whether this line opens or closes a fence (``` or ~~~, any indent). */
function isFence(line: string): boolean {
  return /^\s{0,3}(```|~~~)/.test(line);
}

/**
 * Split into chunks of at least `target` characters, cutting only at blank
 * lines outside fenced code. Returns `[text]` when there is nothing to gain.
 */
export function splitMarkdownChunks(text: string, target = 6_000): string[] {
  if (text.length <= target) return [text];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFence(line)) inFence = !inFence;
    current.push(line);
    size += line.length + 1;

    // A cut point: a blank line, outside a fence, with enough behind it — and
    // never the last line, which would leave an empty chunk.
    const blank = line.trim() === "";
    if (blank && !inFence && size >= target && i < lines.length - 1) {
      chunks.push(current.join("\n"));
      current = [];
      size = 0;
    }
  }
  if (current.length) chunks.push(current.join("\n"));
  // A document that never offered a cut point (one giant table, one fence)
  // comes back whole — better slow than wrong.
  return chunks.length ? chunks : [text];
}

/** The inverse: what the pieces mean together. Used by the probe. */
export function joinMarkdownChunks(chunks: string[]): string {
  return chunks.join("\n");
}
