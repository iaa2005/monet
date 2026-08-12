/**
 * The "the model is busy" row.
 *
 * It used to be a static `Working…`. On a turn that runs for six minutes that
 * is the same pixel for six minutes: a wedged run and a productive one look
 * identical, and the only way to tell them apart is to stop and retry.
 *
 * So it says three things it actually knows:
 *   - a spinner, so motion proves the renderer is alive (a frozen UI shows a
 *     frozen spinner — a shimmer alone keeps sweeping either way);
 *   - what is happening right now, taken from the running tool call rather
 *     than invented;
 *   - how long the turn has been going, which is the number you want before
 *     deciding to interrupt.
 *
 * Token counts are deliberately absent: usage arrives with `message_stop`, at
 * the END of the turn, so anything shown mid-run would be the previous turn's
 * number wearing this turn's label.
 */

import { useEffect, useState } from "react";
import { Shimmer } from "@/components/ui/shimmer";
import { cn } from "@/lib/utils";
import type { ChatMessage, ToolCall } from "@/types/chat";

/** Present tense, because this one is still happening — ToolCallBubble's map
 * is past tense for the same tools ("Ran command" vs "Running command"). */
const RUNNING_NAMES: Record<string, string> = {
  Bash: "Running command",
  PowerShell: "Running PowerShell",
  Read: "Reading",
  Write: "Writing",
  Edit: "Editing",
  MultiEdit: "Editing",
  Grep: "Searching",
  Glob: "Finding files",
  TodoWrite: "Updating the plan",
  Task: "Delegating",
  RunPython: "Running Python",
  RunCommand: "Running command",
  BrowserNavigate: "Opening a page",
  BrowserReadPage: "Reading the page",
  BrowserClick: "Clicking",
  BrowserType: "Typing",
  BrowserScroll: "Scrolling",
  BrowserScreenshot: "Taking a screenshot",
  Computer: "Driving the computer",
  WebSearch: "Searching the web",
  WebFetch: "Fetching a page",
};

/**
 * Filler for when nothing external is running — the model is just thinking,
 * and there is no fact to report. Split by age on purpose: past a minute the
 * honest thing to say is that it is still going, not a fresh cheerful verb.
 */
const EARLY_WORDS = [
  "Working",
  "Thinking",
  "Pondering",
  "Sketching",
  "Composing",
  "Considering",
  "Mulling it over",
  "Mixing colours",
];
const LATE_WORDS = [
  "Still working",
  "Still thinking",
  "Taking its time",
  "Working through it",
  "Not done yet",
];

/** How long one filler word stays up. Long enough to read, short enough that
 * the row never looks stuck. */
const WORD_MS = 5_000;
const LATE_AFTER_MS = 60_000;

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** The tool's primary argument, short enough to sit on one line. */
function argPreview(call: ToolCall): string {
  const str = (k: string): string | undefined =>
    typeof call.input[k] === "string" ? (call.input[k] as string) : undefined;
  const raw =
    call.name === "Bash" || call.name === "PowerShell"
      ? str("command")
      : (str("file_path") ?? str("path")) ??
        str("pattern") ??
        str("query") ??
        str("url") ??
        str("description");
  if (!raw) return "";
  const one = raw.replace(/\s+/g, " ").trim();
  const short =
    call.name === "Bash" || call.name === "PowerShell" ? one : basename(one);
  return short.length > 44 ? `${short.slice(0, 43)}…` : short;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/**
 * What to put next to the spinner.
 *
 * A running tool always wins — "Running command · npm run build" beats any
 * adjective. `startedAt` seeds the filler rotation so two chats started at
 * different moments are not locked in step, and so the word does not jump
 * back to the top of the list every time the row remounts.
 */
export function workingLabel(
  running: ToolCall[],
  elapsedMs: number,
  startedAt: number,
): string {
  if (running.length > 1) return `Running ${running.length} tools`;
  const call = running[0];
  if (call) {
    const name = RUNNING_NAMES[call.name] ?? call.name;
    const arg = argPreview(call);
    return arg ? `${name} · ${arg}` : name;
  }
  const words = elapsedMs >= LATE_AFTER_MS ? LATE_WORDS : EARLY_WORDS;
  const step = Math.floor(elapsedMs / WORD_MS) + startedAt;
  return words[((step % words.length) + words.length) % words.length]!;
}

/** Tool calls the model is waiting on right now. `pending` counts: it has been
 * requested and not answered, which is still time being spent. */
export function runningCalls(messages: ChatMessage[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const m of messages) {
    const c = m.toolCall;
    if (c && (c.status === "running" || c.status === "pending")) out.push(c);
  }
  return out;
}

/**
 * The ring itself. Motion is the point: a shimmer keeps sweeping even when the
 * renderer has stopped painting, so it cannot tell a live turn from a frozen
 * one. A spinner can.
 *
 * Which is why reduced motion SLOWS it instead of stopping it. This carried
 * `motion-reduce:animate-none` for about an hour, and on Windows with
 * "animation effects" switched off — a common, unremarkable setting that
 * Chromium reports as prefers-reduced-motion — that turned the one element
 * whose entire job is to prove liveness into a static ring that reads as a
 * hung app. Every other spinner in this codebase animates unconditionally;
 * a busy indicator that can freeze is worse than no indicator.
 *
 * `inline-block` because a bare <span> is display:inline, where width, height
 * and transform are all ignored. It happens to work today only because both
 * call sites are flex containers, which blockify their children.
 */
export function Spinner({ className }: { className?: string }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-foreground",
        "motion-reduce:[animation-duration:2s]",
        className,
      )}
    />
  );
}

export function WorkingIndicator({
  messages,
  startedAt,
  className,
}: {
  messages: ChatMessage[];
  /** When the current run began. Owned by the parent so the clock survives
   * this component unmounting whenever the model emits a burst of text. */
  startedAt: number;
  className?: string;
}): JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Re-read the clock rather than adding 1000 — an interval that misses ticks
    // (background tab, busy main thread) would otherwise drift slower than real
    // time, which is precisely when the elapsed number matters most.
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const elapsed = Math.max(0, now - startedAt);
  const running = runningCalls(messages);
  const label = workingLabel(running, elapsed, startedAt);

  return (
    <div
      className={cn("flex items-center gap-2 text-sm", className)}
      role="status"
      aria-live="polite"
      aria-label={`${label}, ${formatElapsed(elapsed)} elapsed`}
    >
      <Spinner />
      <Shimmer className="min-w-0 truncate">{label}</Shimmer>
      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
        {formatElapsed(elapsed)}
      </span>
    </div>
  );
}
