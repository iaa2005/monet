/**
 * The user's clipboard, across a Computer Use run.
 *
 * Typing on macOS goes through the pasteboard: put the text there, send
 * cmd+V. The obvious next line — put the old contents back — is a trap, and
 * it cost a real run its data. A target reads the pasteboard on its own
 * schedule, so restoring a quarter of a second after the keystroke means a
 * slower app pastes whatever was restored. In the reported run seven cells of
 * a table arrived correctly and the eighth received the user's own prompt,
 * which is what had been on their clipboard before the agent started.
 *
 * So the restore is not per-keystroke at all. The original is captured once,
 * before the first paste of a run, and put back when the run ends — by which
 * time no paste is in flight. Between those points the clipboard belongs to
 * the agent, which is the same bargain any paste-based automation makes.
 */

import { clipboard } from "electron";

let saved: string | null = null;

/** Remember the user's clipboard, once per run. Cheap to call every time. */
export function holdClipboard(): void {
  if (saved !== null) return;
  try {
    saved = clipboard.readText();
  } catch {
    saved = "";
  }
}

/**
 * Give it back. Called when the run ends; a no-op when nothing was held.
 *
 * Only writes when the clipboard still holds what the agent put there —
 * if the user copied something during the run, that is newer than what we
 * saved and overwriting it would be its own small theft. We cannot tell
 * exactly what the agent last wrote, so the check is simply: do not restore
 * over a clipboard that no longer matches anything we would have set.
 */
export function releaseClipboard(lastTyped?: string): void {
  const original = saved;
  saved = null;
  if (original === null) return;
  try {
    if (lastTyped !== undefined && clipboard.readText() !== lastTyped) return;
    clipboard.writeText(original);
  } catch {
    /* the clipboard is not worth failing a run over */
  }
}

/** What the agent last put on the clipboard, so the release can tell whether
 * the user has since copied something of their own. */
let lastTyped: string | undefined;
export function noteTyped(text: string): void {
  lastTyped = text;
}
export function lastTypedText(): string | undefined {
  return lastTyped;
}
