/**
 * How to open a file that is staged in the composer and not sent yet.
 *
 * A staged attachment is a browser `File`: no path, nothing on disk to read
 * back through IPC, and no size limit of its own — people attach 4K video,
 * 200 MB logs, and scans of entire books. The tile shows a 144px thumbnail,
 * which is enough to recognise a file and not enough to read one, so it can
 * be opened; this decides what "opened" may mean without hanging the window.
 *
 * Three ways, and the difference between them is who holds the bytes:
 *
 *   stream — Chromium does. An object URL for an image, PDF, audio or video
 *            is a handle, not a copy: the size genuinely does not matter, and
 *            it is why these are never read into a string first.
 *   head   — we do, but only the front of it. Text is shown up to a cap and
 *            says how much of the file that was. A 400 MB log is a legitimate
 *            thing to attach and an illegitimate thing to hold as a string.
 *   parse  — we do, all of it, because the format has no other reading: docx
 *            and xlsx are zip archives, a notebook is one JSON document. This
 *            is the only case with a real ceiling.
 *
 * Kept out of FileViewer.tsx so it can be tested on its own — and because a
 * .tsx that exports a non-component loses Fast Refresh for the whole file.
 */

/**
 * The most a staged file may be parsed whole in the renderer.
 *
 * 40 MB of zip or JSON is already a second of work on a good machine. Past
 * that, "too large to open here" is a better answer than a window that stops
 * responding — the file is still sent in full either way.
 */
export const MAX_STAGED_PARSE_BYTES = 40 * 1024 * 1024;

/** How much of a text file is read into the preview. */
export const MAX_STAGED_TEXT_BYTES = 400_000;

export type StagedPlan = "stream" | "head" | "parse" | "too-big" | "none";

/**
 * `kind` is FileViewer's PreviewKind. Typed as a string so this module does
 * not drag the viewer's rendering vocabulary along with it; an unknown kind
 * gets the honest answer rather than a guess.
 */
export function planStagedPreview(kind: string, size: number): StagedPlan {
  switch (kind) {
    case "image":
    case "pdf":
    case "audio":
    case "video":
      return "stream";
    case "text":
      return "head";
    case "docx":
    case "xlsx":
    case "notebook":
      return size > MAX_STAGED_PARSE_BYTES ? "too-big" : "parse";
    default:
      return "none";
  }
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Said when a format has to be read whole and the file is too big for that. */
export function tooBigMessage(size: number): string {
  return (
    `${humanBytes(size)} is too large to open here — this format has to be ` +
    `read whole. It will still be sent in full; open it outside the app to ` +
    `read it now.`
  );
}

/** Said at the end of a text preview that stopped short of the file's end. */
export function truncatedNote(shown: number, total: number): string {
  return `\n\n… (truncated — showing the first ${humanBytes(shown)} of ${humanBytes(total)})`;
}
