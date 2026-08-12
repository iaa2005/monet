/**
 * Build a value the first time it is asked for, then keep it.
 *
 * Every tool in this app declares a Zod schema, and building them all at
 * module-init would run hundreds of schema constructors during startup for
 * tools the turn may never use. The factory defers that to first access.
 *
 * Ours now rather than the vendor's: it was eight lines with no dependencies
 * and twenty-eight importers — the single largest source of coupling to that
 * tree, and the cheapest to end. See DESIGN notes in vendor-tools.ts for what
 * still has to come from there and why.
 */
export function lazySchema<T>(factory: () => T): () => T {
  let cached: T | undefined;
  return () => (cached ??= factory());
}
