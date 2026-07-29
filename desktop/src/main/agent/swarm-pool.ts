/**
 * Bounded, staggered fan-out for the swarm.
 *
 * Two separate limits, because they guard against different things:
 *
 *  - **Concurrency** bounds how many sub-agents are alive at once. Each is a
 *    full model loop with its own context, so twenty at once is twenty
 *    simultaneous conversations being paid for.
 *  - **Stagger** bounds how fast they START. A pool alone still opens every
 *    one of its slots in the same millisecond, and a provider answers that
 *    with 429s. Kimi Code ramps for the same reason (five immediately, then
 *    one every 700ms); this expresses it as a minimum gap between starts.
 *
 * One item failing must not lose the others' work, so every result is captured
 * — success or failure — and the caller decides what to say about it.
 *
 * Pure scheduling: no agents, no model. The timing rules are the part that is
 * easy to get subtly wrong, so they are testable on their own.
 */

/** The placeholder each item replaces in the prompt template. */
export const ITEM_PLACEHOLDER = "{{item}}";

/**
 * Ceiling on one swarm.
 *
 * Every item is a full agent with its own context, so this is a spend limit as
 * much as a load one. Kimi allows 128; that is a number for a service with its
 * own quota behind it, and a desktop app billing a personal API key should not
 * make it easy to start 128 conversations by accident.
 */
export const MAX_ITEMS = 40;

export interface SwarmOutcome<T> {
  index: number;
  item: string;
  /** Present when the task resolved. */
  value?: T;
  /** Present when it threw. */
  error?: string;
}

export interface SwarmOptions {
  /** Most tasks alive at once. */
  concurrency: number;
  /** Minimum gap between two starts, in ms. 0 disables the stagger. */
  staggerMs: number;
  /** How many may start without waiting, before the stagger applies. */
  burst: number;
  /** Called after each task settles, for progress reporting. */
  onSettled?: (done: number, total: number, failures: number) => void;
  /** Stop starting new tasks. Those already running are left to finish. */
  isAborted?: () => boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `task` over `items`, at most `concurrency` at a time, starting no faster
 * than `staggerMs` apart after the first `burst`.
 *
 * Results come back in ITEM order regardless of completion order — the report
 * has to line up with the list the user gave.
 */
export async function runSwarm<T>(
  items: string[],
  task: (item: string, index: number) => Promise<T>,
  opts: SwarmOptions,
): Promise<SwarmOutcome<T>[]> {
  const results: SwarmOutcome<T>[] = new Array(items.length);
  let next = 0;
  let started = 0;
  let done = 0;
  let failures = 0;
  /** Earliest moment the next start may happen. Reserved synchronously. */
  let nextSlot = 0;

  const workers = Math.max(1, Math.min(opts.concurrency, items.length));

  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.isAborted?.()) return;
      const index = next++;
      if (index >= items.length) return;
      const item = items[index]!;

      // Claim a start slot SYNCHRONOUSLY, then wait for it.
      //
      // The obvious version — compare against the last start, then sleep the
      // difference — is a race, and a quiet one: every worker past the burst
      // reads the same "last start", sleeps the same amount, and they all wake
      // together, so the stagger produces one clump instead of a queue.
      // Observed as starts at [0, 0, 47, 47, 47] with a 40ms stagger. Nothing
      // downstream notices; the provider just sees the burst it was meant not
      // to see. Reserving the slot before the await is what makes the queue
      // real.
      const rank = started++;
      if (opts.staggerMs > 0) {
        const now = Date.now();
        const slot = rank < opts.burst ? now : Math.max(now, nextSlot);
        nextSlot = slot + opts.staggerMs;
        if (slot > now) await sleep(slot - now);
      }
      // Re-check: the wait above is long enough for an abort to arrive.
      if (opts.isAborted?.()) {
        results[index] = { index, item, error: "Cancelled before starting." };
        continue;
      }

      try {
        results[index] = { index, item, value: await task(item, index) };
      } catch (err) {
        failures++;
        results[index] = {
          index,
          item,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      done++;
      opts.onSettled?.(done, items.length, failures);
    }
  };

  await Promise.all(Array.from({ length: workers }, () => worker()));

  // An abort can leave holes; fill them so the caller never sees `undefined`
  // where it expects an outcome.
  for (let i = 0; i < items.length; i++) {
    results[i] ??= { index: i, item: items[i]!, error: "Cancelled." };
  }
  return results;
}

/**
 * Assemble the per-item report the parent model reads.
 *
 * The closing warning is the important line. A batch where three of twenty
 * items failed is not "done": without saying so plainly, a model that reads
 * seventeen good reports concludes the work is finished, and the three gaps
 * are never mentioned to the user.
 */
export function buildSwarmReport(
  outcomes: { index: number; item: string; value?: string; error?: string }[],
): string {
  const bad = outcomes.filter((o) => o.error !== undefined);
  const ok = outcomes.length - bad.length;
  const lines: string[] = [
    `Swarm finished: ${ok} of ${outcomes.length} succeeded` +
      (bad.length ? `, ${bad.length} failed.` : "."),
    "",
  ];
  for (const o of outcomes) {
    lines.push(`## ${o.index + 1}. ${o.item}`);
    lines.push(o.error === undefined ? (o.value ?? "(no report)") : `FAILED: ${o.error}`);
    lines.push("");
  }
  if (bad.length > 0) {
    lines.push(
      `${bad.length} item(s) failed. Their work was NOT done — decide whether to ` +
        `retry those specifically before treating the batch as complete.`,
    );
  }
  return lines.join("\n");
}
