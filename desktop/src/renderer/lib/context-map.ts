/**
 * Which of the messages on screen the model can still read.
 *
 * The chat shows everything that was ever said; the model's context does not.
 * Two things take messages away, from opposite ends:
 *
 *   - a COMPACTION folds the front of the conversation into a summary;
 *   - "Undo last prompt" drops the most recent prompt and its reply.
 *
 * Neither touches the transcript on screen, so until now the difference was
 * invisible: the user reads a chat where half the turns are, to the model,
 * things that never happened. Worse, "which half" is unguessable — the two
 * operations cut from opposite ends.
 *
 * The unit here is the USER TURN, counted from the beginning of the chat and
 * never renumbered ("absolute"). The context renumbers itself after every
 * compaction, which is why each event records the turn counts it saw plus the
 * `headOffset` — the turns earlier compactions had already taken off the
 * front. Offset plus context-relative count gives an absolute range, and
 * absolute ranges are what the display can be marked with.
 *
 * Pure: given the events and the roles of the messages on screen, the answer
 * is arithmetic — which is the part worth pinning down, since a boundary off
 * by one turn tells the user a lie about what the model knows.
 */

export interface ContextEventInfo {
  id: string;
  type: string;
  at: string;
  manual?: boolean;
  undo?: boolean;
  beforeTokens?: number | null;
  afterTokens?: number | null;
  userTurnsBefore?: number | null;
  userTurnsAfter?: number | null;
  headOffset?: number | null;
}

export type OutKind = "compacted" | "undone";

/** A run of user turns the model can no longer read, in absolute turns. */
export interface OutRange {
  id: string;
  kind: OutKind;
  at: string;
  /** First absolute user turn out of context (0-based, inclusive). */
  from: number;
  /** One past the last (exclusive). */
  to: number;
  beforeTokens?: number | null;
  afterTokens?: number | null;
  manual?: boolean;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The ranges, oldest first.
 *
 * An event with no turn counts is one recorded before this app knew how to
 * write them down — it is skipped rather than guessed at, because a marker in
 * the wrong place is worse than no marker.
 */
export function outOfContextRanges(events: ContextEventInfo[]): OutRange[] {
  const out: OutRange[] = [];
  for (const e of events) {
    const before = num(e.userTurnsBefore);
    const after = num(e.userTurnsAfter);
    const head = num(e.headOffset) ?? 0;
    if (before == null || after == null || before <= after) continue;
    if (e.type === "compact") {
      // The front went into a summary: the turns just below the new start.
      out.push({
        id: e.id,
        kind: "compacted",
        at: e.at,
        from: head,
        to: head + (before - after),
        beforeTokens: e.beforeTokens ?? null,
        afterTokens: e.afterTokens ?? null,
        manual: e.manual,
      });
    } else if (e.type === "rewind") {
      // The tail was dropped: everything the context kept stays, the rest of
      // what was there at the time is gone.
      out.push({
        id: e.id,
        kind: "undone",
        at: e.at,
        from: head + after,
        to: head + before,
      });
    }
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

/**
 * The absolute user turn each displayed message belongs to.
 *
 * A message belongs to the prompt above it; anything before the first prompt
 * (a restored greeting, a routine's own opening) belongs to no turn and is
 * left alone.
 */
export function turnOrdinals(roles: readonly string[]): number[] {
  let ordinal = -1;
  return roles.map((r) => {
    if (r === "user") ordinal++;
    return ordinal;
  });
}

export interface ContextMap {
  /** Display indices the model can no longer read. */
  out: Set<number>;
  /** Where an event's marker goes: display index → the ranges that ended
   * just before it. */
  markers: Map<number, OutRange[]>;
  /** Ranges whose region runs to the end of the transcript — their marker
   * belongs after the last message. */
  trailing: OutRange[];
  /** Turns on screen that the model still has. */
  inContextTurns: number;
}

/**
 * Fold the ranges onto the messages actually on screen.
 *
 * A range that reaches past the end of the transcript is clamped: the chat
 * cannot mark what it is not showing, and an event from a chat whose display
 * was trimmed must not push its marker off the end.
 */
export function buildContextMap(
  roles: readonly string[],
  ranges: readonly OutRange[],
): ContextMap {
  const ordinals = turnOrdinals(roles);
  const totalTurns = ordinals.length ? ordinals[ordinals.length - 1]! + 1 : 0;
  const out = new Set<number>();
  const markers = new Map<number, OutRange[]>();
  const trailing: OutRange[] = [];

  // First display index of each absolute turn, for placing the markers.
  const firstIndexOfTurn = new Map<number, number>();
  ordinals.forEach((t, i) => {
    if (t >= 0 && !firstIndexOfTurn.has(t)) firstIndexOfTurn.set(t, i);
  });

  for (const r of ranges) {
    if (r.from >= totalTurns) continue; // nothing on screen to mark
    for (let i = 0; i < ordinals.length; i++) {
      const t = ordinals[i]!;
      if (t >= r.from && t < r.to) out.add(i);
    }
    const at = firstIndexOfTurn.get(r.to);
    if (at == null) trailing.push(r);
    else {
      const list = markers.get(at) ?? [];
      list.push(r);
      markers.set(at, list);
    }
  }

  return {
    out,
    markers,
    trailing,
    inContextTurns: Math.max(0, totalTurns - countOutTurns(ranges, totalTurns)),
  };
}

function countOutTurns(
  ranges: readonly OutRange[],
  totalTurns: number,
): number {
  // Ranges can in principle overlap (a compaction after an undo); count the
  // union so the tally cannot exceed the conversation.
  const seen = new Set<number>();
  for (const r of ranges)
    for (let t = r.from; t < Math.min(r.to, totalTurns); t++) seen.add(t);
  return seen.size;
}

/** One line saying what an event did, for the marker in the transcript. */
export function describeRange(r: OutRange): string {
  if (r.kind === "undone") {
    const n = r.to - r.from;
    return `Undo — ${n} prompt${n === 1 ? "" : "s"} dropped from context`;
  }
  const saved =
    r.beforeTokens != null && r.afterTokens != null
      ? ` · ${fmtTokens(r.beforeTokens)} → ${fmtTokens(r.afterTokens)}`
      : "";
  return `${r.manual ? "Compacted" : "Auto-compacted"} — earlier turns summarised${saved}`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
