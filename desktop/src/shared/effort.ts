/**
 * How hard to think — a ladder that belongs to the MODEL, not to the app.
 *
 * The composer used to offer one fixed set of seven steps to every model:
 * Off, Minimal, Low, Medium, High, X-High, Max. It is wrong nearly
 * everywhere, and wrong silently, which is the bad kind:
 *
 *   llama.cpp takes four — low, medium, high, xhigh. There is no "minimal"
 *   and no "max"; sending one is a flag the server does not recognise.
 *
 *   OpenAI takes minimal, low, medium, high. No xhigh, no max — the client
 *   was already quietly clamping the top two down to "high", so the two
 *   smartest-looking steps on the slider did the same thing as the third.
 *
 *   Anthropic has no named levels at all. It has a thinking BUDGET in
 *   tokens, and the names are this app's own invention on top of it — which
 *   is why a ladder of any length can be mapped onto it by position.
 *
 *   OpenRouter normalises a unified `reasoning.effort` across all of them,
 *   so it really does take the full set.
 *
 * So the ladder is data: discovered from the server where the server knows
 * (Monet Local publishes `effort_levels`), and otherwise the honest default
 * for that kind of provider. Order is weakest first, and POSITION is what
 * carries meaning across models — "the top step" survives a switch from a
 * six-step model to a four-step one, while the name "max" does not.
 */

/** The names this app knows how to talk about. Others are passed through. */
export const KNOWN_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type KnownEffort = (typeof KNOWN_EFFORTS)[number];

/**
 * A step on some model's ladder.
 *
 * Deliberately `string`: a model may name its steps anything, and the point
 * of this whole file is that the app does not get to decide the list. The
 * union is kept in the type only so the common names still autocomplete.
 */
export type EffortLevel = KnownEffort | (string & {});

/**
 * What each kind accepts when nothing better is known.
 *
 * These are the APIs' own sets, not a house style — see the note above for
 * where each comes from. A kind with no entry gets the full list: it is a
 * pass-through endpoint, and refusing steps a server might accept is worse
 * than offering one it ignores.
 */
const BY_KIND: Record<string, readonly string[]> = {
  openai: ["minimal", "low", "medium", "high"],
  deepseek: ["low", "medium", "high"],
  // No named levels — these are this app's own budget steps (see
  // thinkingBudget below), so the ladder can be as long as it likes.
  anthropic: ["low", "medium", "high", "xhigh", "max"],
  // Normalised by OpenRouter to whatever the underlying provider wants.
  openrouter: [...KNOWN_EFFORTS],
  // llama.cpp's `--reasoning-effort`. Published per model by Monet Local, so
  // this is only the fallback for an older build that does not send it.
  "monet-local": ["low", "medium", "high", "xhigh"],
};

const FULL: readonly string[] = KNOWN_EFFORTS;

/**
 * The steps to offer for a model, weakest first.
 *
 * `levels` is what the model itself reported (or what the user typed into
 * its settings); everything else is a fallback. Empty is not a valid ladder
 * — a model that supports effort supports something — so it falls through.
 */
export function effortLadder(
  kind: string | undefined,
  levels?: readonly string[],
): readonly string[] {
  if (levels?.length) return levels;
  return (kind ? BY_KIND[kind] : undefined) ?? FULL;
}

/** Index of a level in a ladder, or -1. Case- and space-insensitive. */
export function effortIndex(
  level: string | null | undefined,
  ladder: readonly string[],
): number {
  if (!level) return -1;
  const want = level.trim().toLowerCase();
  return ladder.findIndex((l) => l.toLowerCase() === want);
}

/**
 * Carry a choice from one model's ladder to another's.
 *
 * By POSITION, not by name. Someone who picked the hardest-thinking step on
 * a six-step model means "think as hard as you can", and on a four-step
 * model that is the fourth step — not "max", which does not exist there and
 * would silently become no setting at all.
 *
 * A level that is not on the old ladder either (a stored value from an
 * older build, a hand-typed one) keeps its name if the new ladder has it,
 * and is otherwise dropped: guessing a position from nothing is how a
 * "medium" becomes a "max" on the next model.
 */
export function remapEffort(
  level: string | null | undefined,
  from: readonly string[],
  to: readonly string[],
): string | null {
  if (!level) return null;
  if (!to.length) return null;
  const here = effortIndex(level, to);
  if (here >= 0) return to[here]!;
  const there = effortIndex(level, from);
  if (there < 0) return null;
  if (from.length === 1) return to[to.length - 1]!;
  const share = there / (from.length - 1);
  return to[Math.round(share * (to.length - 1))]!;
}

/** "xhigh" → "X-High", "medium" → "Medium", "ultra_think" → "Ultra think". */
export function prettyEffort(level: string): string {
  const v = level.trim().toLowerCase();
  if (v === "xhigh") return "X-High";
  if (v === "minimal") return "Minimal";
  const spaced = v.replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Extended-thinking budget in tokens, for a provider that has no names. */
const MIN_BUDGET = 1024;
const MAX_BUDGET = 30_720;

/**
 * Anthropic's thinking budget for a step on ANY ladder.
 *
 * Spread over the ladder by position rather than looked up by name, which is
 * what lets a model with three steps or with names nobody has seen before
 * still get a sensible budget. The two ends are fixed points: the weakest
 * step is a token of thought, the strongest is as much as this app will ask
 * for.
 */
export function thinkingBudget(
  level: string | null | undefined,
  ladder: readonly string[],
): number | null {
  const i = effortIndex(level, ladder);
  if (i < 0) return null;
  if (ladder.length === 1) return MAX_BUDGET;
  const share = i / (ladder.length - 1);
  return Math.round(MIN_BUDGET + share * (MAX_BUDGET - MIN_BUDGET));
}
