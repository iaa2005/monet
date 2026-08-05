/**
 * The step budget: telling the model it exists, and landing the plane when it
 * runs out.
 *
 * A run gets a fixed number of tool-calling turns per message. The cap is the
 * only thing standing between a stuck model and an unbounded bill, so it does
 * not move — but the way it used to END was indefensible: the loop simply
 * fell through and emitted `message_stop`, throwing away everything the run
 * had learned. Seen in a real chat: forty turns spent fighting a Jupyter UI,
 * then nothing on screen at all — no summary, no "here is what is done", no
 * next step. The user is left staring at a half-finished thought.
 *
 * Two cheap corrections, both of them prompts:
 *
 *   1. A heads-up before the end. The model spends its steps as if there were
 *      no limit, because nothing ever told it otherwise. One line near the
 *      end — "N steps left, start converging" — is enough to make it finish
 *      the valuable thread instead of opening a new one.
 *   2. A wrap-up turn AFTER the last one, with the tools taken away. It
 *      cannot act any more; it can still say what happened. Silence becomes a
 *      handoff, which is the thing the user actually needed from those turns.
 *
 * Pure: the arithmetic of "when to warn" is what a probe pins down, and the
 * words are worth having in one place where they can be read.
 */

/**
 * A cap the same size for everyone is the wrong instrument. Forty steps is
 * plenty for a model going in circles and not nearly enough for a strong one
 * doing a large, honest job — and the two are told apart by EVIDENCE, not by
 * asking the model whether it would like more (it always would).
 *
 * The evidence is repetition. A run that keeps calling the same tool with the
 * same arguments is stuck, whatever it says in its narration; a run whose
 * calls keep differing is working. In the Jupyter run that prompted this,
 * `BrowserReadPage {}` came back ten times identically — visible from the
 * harness, invisible to the model.
 *
 * So the budget extends, twice at most, and only while the recent calls are
 * mostly new work.
 */
export const EXTENSION_TURNS = 20;
export const MAX_EXTENSIONS = 2;
/** How many recent calls the productivity judgement looks at. */
export const PROGRESS_WINDOW = 12;
/** Below this share of distinct calls the run is repeating itself. */
export const DISTINCT_RATIO = 0.6;

/** Warn once, when this fraction of the budget is gone. */
export const WARN_AT_FRACTION = 0.75;

/**
 * Whether THIS finished turn is the one that earns the heads-up.
 *
 * `turnIndex` is zero-based and counts the turn that just completed, so the
 * note rides back with its tool results and the model reads it before
 * spending the next step.
 */
export function shouldWarnBudget(turnIndex: number, maxTurns: number): boolean {
  if (maxTurns < 4) return false; // too small to be worth a warning
  return turnIndex + 1 === Math.floor(maxTurns * WARN_AT_FRACTION);
}

export function stepsLeft(turnIndex: number, maxTurns: number): number {
  return Math.max(0, maxTurns - (turnIndex + 1));
}

/** The heads-up itself — short, because it is paid for out of the same budget. */
export function budgetWarning(left: number): string {
  return [
    `[${left} step(s) left for this message.`,
    "Start converging: finish the thread most likely to produce a result, and",
    "do not open a new line of investigation. If it cannot be finished, say",
    "what is done and what remains rather than spending the rest exploring.]",
  ].join(" ");
}

/**
 * One call, as a comparable string. The input matters as much as the name:
 * ten `BrowserClick`s on ten different elements is work, ten on the same one
 * is a loop.
 */
export function callSignature(
  name: string,
  input: Record<string, unknown>,
): string {
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    json = "";
  }
  return `${name}:${json.slice(0, 200)}`;
}

/**
 * Is the run still doing new things?
 *
 * Judged over the recent window only — a run that spent thirty good turns and
 * then started spinning must not be carried by its own history.
 */
export function isProductive(
  signatures: string[],
  window: number = PROGRESS_WINDOW,
): boolean {
  const recent = signatures.slice(-window);
  // Too little to judge: give the benefit of the doubt rather than cut a run
  // short on no evidence.
  if (recent.length < 4) return true;
  return new Set(recent).size / recent.length >= DISTINCT_RATIO;
}

// ─── Loop steering ──────────────────────────────────────────────────────
//
// isProductive() already SEES a stuck run — but until now it only refused to
// extend the budget, and never told the model. The model kept re-issuing the
// same call until the steps ran out, because from inside, every identical
// result looks like one more datum rather than a mirror. little-coder's
// quality-monitor sends the correction straight into the run, capped so a
// nudge that does not take cannot become its own loop; both rules are kept.

export const MAX_LOOP_STEERS = 2;
/** Calls a correction gets to take effect before it may be repeated. */
export const STEER_SPACING = 6;
/** Repeats of one exact call before it counts as THE loop, not variance. */
export const DOMINANT_MIN = 3;

/** The single most-repeated recent call, when it repeats enough to name. */
export function dominantRepeat(
  signatures: string[],
  window: number = PROGRESS_WINDOW,
): { toolName: string; count: number } | null {
  const recent = signatures.slice(-window);
  const counts = new Map<string, number>();
  for (const s of recent) counts.set(s, (counts.get(s) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [s, n] of counts)
    if (n > bestCount) {
      best = s;
      bestCount = n;
    }
  if (!best || bestCount < DOMINANT_MIN) return null;
  return { toolName: best.slice(0, best.indexOf(":")), count: bestCount };
}

export interface LoopSteerState {
  signatures: string[];
  steersUsed: number;
  /** Calls made since the last steer (or since the run began). */
  sinceLastSteer: number;
}

export function shouldSteerLoop(state: LoopSteerState): boolean {
  if (state.steersUsed >= MAX_LOOP_STEERS) return false;
  if (state.sinceLastSteer < STEER_SPACING) return false;
  if (isProductive(state.signatures)) return false;
  return dominantRepeat(state.signatures) !== null;
}

/** What the model reads. Names the call, because "you are repeating
 * yourself" without evidence reads as noise and gets ignored. */
export function loopNote(toolName: string, count: number): string {
  return [
    `[Harness note: your recent tool calls are repeating — ${toolName} ran`,
    `${count} times with identical input, and the result will not change on`,
    "another try. Change something real: different input, a different tool,",
    "or tell the user what is blocking you.]",
  ].join(" ");
}

export interface ExtensionState {
  /** Turns the run has already spent. */
  turnsDone: number;
  /** The budget as it stands, extensions included. */
  budget: number;
  extensionsUsed: number;
  /** Every tool call the run has made, in order. */
  signatures: string[];
}

/** Extra turns to grant, or 0 to let the budget end the run. */
export function extensionFor(state: ExtensionState): number {
  if (state.turnsDone < state.budget) return 0; // not at the wall yet
  if (state.extensionsUsed >= MAX_EXTENSIONS) return 0;
  if (!isProductive(state.signatures)) return 0;
  return EXTENSION_TURNS;
}

/** What the model is told when the budget grows. Honest about why. */
export function extensionNote(extra: number, total: number): string {
  return [
    `[Your step budget was extended by ${extra} (to ${total}) because this run`,
    "is still producing new work rather than repeating itself. It will not be",
    "extended indefinitely — get to a result.]",
  ].join(" ");
}

/**
 * What the model is asked once its steps are gone.
 *
 * Deliberately blunt about the tools being gone: a model told to "summarise"
 * while it still believes it can act will try to act, waste the turn on a
 * tool call that cannot be answered, and end in the same silence.
 */
export const WRAP_UP_PROMPT = [
  "[You have run out of steps for this message — the tools are gone for this",
  "turn, so do not try to call one.",
  "",
  "Tell the user, in a few sentences:",
  "- what you actually accomplished (what is true now that was not before),",
  "- what is still broken or unfinished,",
  "- the single next step you would take, concretely.",
  "",
  "No apologies and no plan document — this is a handoff, and they will",
  "decide whether to continue.]",
].join("\n");
