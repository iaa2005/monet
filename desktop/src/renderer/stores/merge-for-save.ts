/**
 * What actually reaches SessionStore.save().
 *
 * `save()` is DELETE-every-row + INSERT-what-you-were-given, so whatever this
 * returns IS the session's history afterwards. A buffer that only holds part of
 * the chat therefore deletes the rest.
 *
 * That happened: the agent runs in the main process and keeps streaming across
 * a renderer reload, so after one the store is empty while `chat:token` events
 * are still arriving. The reducer rebuilt the session out of those events alone
 * and the next save wiped everything from before the reload — the user saw the
 * first half of their chat disappear.
 *
 * Kept in its own module, free of zustand and `window`, so the probe exercises
 * this exact function rather than a copy of the rule.
 */

/** The fields this needs; the real ChatMessage has more. */
export interface MergeableMessage {
  id: string;
}

/**
 * @param buffer   what the renderer currently holds
 * @param hydrated whether `buffer` is known to be the WHOLE history
 * @param dbRows   what the database currently holds
 *
 * An un-hydrated buffer gets the rows it never saw spliced back in front, by
 * id. A hydrated one is returned untouched even when it is shorter — retry,
 * edit and /undo shorten it deliberately, and re-adding those messages would
 * resurrect exactly what the user removed.
 *
 * On overlap the buffer's copy wins: a streaming message grows, so ours is the
 * newer of the two.
 */
export function mergeForSave<T extends MergeableMessage>(
  buffer: T[],
  hydrated: boolean,
  dbRows: T[] | undefined,
): T[] {
  if (hydrated || !dbRows?.length) return buffer;
  const mine = new Set(buffer.map((m) => m.id));
  const missing = dbRows.filter((m) => !mine.has(m.id));
  return missing.length ? [...missing, ...buffer] : buffer;
}
