/**
 * Grouping a turn's tool calls into batches that may run together.
 *
 * The agent loop ran every call one after another — five Reads and three Greps
 * in one response were eight sequential round trips. The tools have declared
 * `isConcurrencySafe()` all along (Grep and Read say true, RunPython says
 * false); nothing ever read it.
 *
 * Consecutive safe calls form a batch; an unsafe call is a batch of one and a
 * barrier. Order is preserved across batches, which is what makes this safe to
 * do at all: `Edit` after `Write` on the same file must still see the write,
 * and the read-before-edit cache must not be raced.
 *
 * Pure — no tool execution here, so the grouping rules can be tested without
 * a filesystem or a model.
 */

/** The bit of a Tool this module needs. */
export interface BatchableTool {
  name: string;
  isConcurrencySafe(input: unknown): boolean;
}

export interface BatchableCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Most simultaneous calls in one batch.
 *
 * Reads are cheap, but a batch is not always reads: MCP tools count as
 * concurrency-safe and each may be a network request to someone else's server.
 * Eight is well past the point where latency stops dominating and comfortably
 * short of looking like a denial of service.
 */
export const MAX_PARALLEL = 8;

/**
 * Split calls into ordered batches.
 *
 * A batch of one runs alone, exactly as before. A batch of several runs
 * together. Every batch completes before the next begins.
 */
export function planBatches(
  calls: BatchableCall[],
  lookup: (name: string) => BatchableTool | undefined,
  maxParallel: number = MAX_PARALLEL,
): BatchableCall[][] {
  const batches: BatchableCall[][] = [];
  let current: BatchableCall[] = [];

  const flush = (): void => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
    }
  };

  for (const call of calls) {
    const tool = lookup(call.name);
    let safe = false;
    try {
      // An unknown tool is NOT safe: it will fail in execution, and grouping a
      // call whose semantics we cannot look up is exactly the wrong guess.
      safe = tool ? tool.isConcurrencySafe(call.input) === true : false;
    } catch {
      // A tool that throws while answering the question has not said yes.
      safe = false;
    }

    if (!safe) {
      flush();
      batches.push([call]);
      continue;
    }

    current.push(call);
    if (current.length >= maxParallel) flush();
  }
  flush();
  return batches;
}

/** True when the plan would run anything concurrently — for logging. */
export function hasParallelism(batches: BatchableCall[][]): boolean {
  return batches.some((b) => b.length > 1);
}

/**
 * Run the batches and collect results IN CALL ORDER.
 *
 * The ordering is the part worth being careful about: inside a batch the calls
 * finish in whatever order they finish, and a result list that follows
 * completion order instead of call order would pair tool_result blocks with
 * the wrong tool_use ids for anything reading positionally.
 *
 * `run` is expected never to reject — a failing tool returns a result marked
 * as an error — so Promise.all is right here: a rejection would be a bug in
 * the caller, and allSettled would bury it.
 */
export async function runBatches<R>(
  batches: BatchableCall[][],
  run: (call: BatchableCall) => Promise<R>,
  isAborted: () => boolean = () => false,
): Promise<{ results: R[]; aborted: boolean }> {
  const results: R[] = [];
  for (const batch of batches) {
    // Checked between batches, not inside one: a batch already in flight is
    // left to finish, because its tools have side effects we cannot unwind
    // and half-recorded results are worse than late ones.
    if (isAborted()) return { results, aborted: true };
    if (batch.length === 1) {
      results.push(await run(batch[0]!));
    } else {
      results.push(...(await Promise.all(batch.map(run))));
    }
  }
  return { results, aborted: false };
}
