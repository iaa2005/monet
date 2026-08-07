/**
 * What a turn actually changed on disk, and what it did not.
 *
 * The naive answer is to trust the tools: Edit and Write know which file
 * they wrote. That answer is wrong, and wrong in the direction that loses
 * work — a model that runs a Python script, a build, a formatter or a
 * `git checkout` changes files no tool reported. Restoring "the files the
 * tools wrote" would leave those behind, and the user would find a
 * half-restored tree.
 *
 * So the truth comes from the DISK, as a before/after index. The only
 * question left is WHOSE change it was, because the person at the keyboard
 * may be editing the same project at the same time, and their work must
 * never be reverted by a rewind.
 *
 * That question is answered by WINDOWS. A tool call is a window: whatever
 * changed between its start and its end is the turn's. The gaps between
 * tool calls — while the model is thinking, or streaming text — belong to
 * the user. A file that only ever changes in a gap is theirs and is left
 * alone; a file that changes in a window is the turn's, even if a tool
 * never named it.
 *
 * Everything here is arithmetic over indexes, with no filesystem and no
 * git, so the rule that decides whether somebody's work is safe can be
 * checked directly.
 */

/**
 * Path → content hash. A path that is ABSENT from the map does not exist
 * on disk; that distinction is what tells a created file from a modified
 * one, and a deleted file from an untouched one.
 */
export type FileIndex = Map<string, string>;

export interface Delta {
  /** Did not exist before, exists now. */
  added: string[];
  /** Existed before and after, with different content. */
  modified: string[];
  /** Existed before, gone now. */
  removed: string[];
}

export const EMPTY_DELTA: Delta = { added: [], modified: [], removed: [] };

/** Every path either side knows about. */
function allPaths(a: FileIndex, b: FileIndex): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].sort();
}

/** What happened between two indexes. */
export function changedIn(before: FileIndex, after: FileIndex): Delta {
  const delta: Delta = { added: [], modified: [], removed: [] };
  for (const path of allPaths(before, after)) {
    const was = before.get(path);
    const now = after.get(path);
    if (was === undefined && now !== undefined) delta.added.push(path);
    else if (was !== undefined && now === undefined) delta.removed.push(path);
    else if (was !== undefined && now !== undefined && was !== now)
      delta.modified.push(path);
  }
  return delta;
}

/** Every path a delta mentions, whatever happened to it. */
export function pathsOf(delta: Delta): string[] {
  return [...new Set([...delta.added, ...delta.modified, ...delta.removed])].sort();
}

/**
 * Fold a window's delta into the turn's running ledger.
 *
 * The classification is of the WHOLE TURN, not of the last window, which
 * is why this is not a concatenation:
 *
 *   - created and then edited again is still CREATED — a restore deletes
 *     it, and deleting it twice is not a thing;
 *   - created and then deleted within the turn is NOTHING — the file was
 *     never there before and is not there now, and a restore that tried
 *     to "put it back" would resurrect a file the turn deliberately
 *     removed;
 *   - deleted and then recreated is MODIFIED — it exists at both ends,
 *     with different content;
 *   - modified twice is modified once.
 */
export function foldDelta(ledger: Delta, next: Delta): Delta {
  const added = new Set(ledger.added);
  const modified = new Set(ledger.modified);
  const removed = new Set(ledger.removed);

  for (const path of next.added) {
    if (removed.delete(path)) modified.add(path);
    else added.add(path);
  }
  for (const path of next.modified) {
    // A file this turn created is still "created", however often it is
    // then rewritten.
    if (!added.has(path)) modified.add(path);
  }
  for (const path of next.removed) {
    if (added.delete(path)) continue; // created and removed: never existed
    modified.delete(path);
    removed.add(path);
  }

  return {
    added: [...added].sort(),
    modified: [...modified].sort(),
    removed: [...removed].sort(),
  };
}

/**
 * Drop from the turn's ledger anything the USER changed outside it.
 *
 * A file both sides touched is contested, and the tie goes to the person
 * at the keyboard: their edit is unsaved work that a rewind would destroy,
 * while the turn's change is recoverable from the checkpoint. So a
 * contested file is left exactly as it is, and named, so the rewind can
 * say what it did not do rather than quietly do less than it claimed.
 */
export function withoutUserEdits(
  ledger: Delta,
  userTouched: Iterable<string>,
): { ledger: Delta; skipped: string[] } {
  const theirs = new Set(userTouched);
  if (theirs.size === 0) return { ledger, skipped: [] };
  const keep = (paths: string[]): string[] => paths.filter((p) => !theirs.has(p));
  const skipped = pathsOf(ledger).filter((p) => theirs.has(p));
  return {
    ledger: {
      added: keep(ledger.added),
      modified: keep(ledger.modified),
      removed: keep(ledger.removed),
    },
    skipped,
  };
}

/** Nothing to restore. */
export function isEmpty(delta: Delta): boolean {
  return (
    delta.added.length === 0 &&
    delta.modified.length === 0 &&
    delta.removed.length === 0
  );
}

/**
 * What a restore will do, in the order it must do it.
 *
 * `write` are files to put back from the checkpoint (the turn modified or
 * deleted them); `delete` are files to remove (the turn created them).
 * Stated as a plan rather than performed here so the UI can show it —
 * "these files, +n/−n" — before anything is touched.
 */
export function restorePlan(ledger: Delta): {
  write: string[];
  delete: string[];
} {
  return {
    write: [...ledger.modified, ...ledger.removed].sort(),
    delete: [...ledger.added].sort(),
  };
}
