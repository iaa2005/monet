/**
 * Pull a JSON object out of a model reply.
 *
 * Three callers needed this and each had its own copy: the nightly memory
 * consolidation, the Reflect digest, and the routine drafter. The drafter's
 * copy used indexOf/lastIndexOf and produced "" for an empty reply, so
 * JSON.parse threw and the whole feature fell back to dumping the raw text into
 * the form — which is what "Draft routine does nothing" actually was.
 */

/**
 * First balanced JSON object in the reply. A plain lastIndexOf("}") breaks when
 * the model wraps its JSON in prose that itself contains a brace.
 *
 * Returns `truncated` when the object never closes — the realistic failure
 * here, since a plan carries a full replacement body per file and Cyrillic
 * costs roughly twice the tokens per character. See salvage() for what we do
 * with a cut-off plan.
 */
export function extractJson(text: string): { value: unknown; truncated: boolean } {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = cleaned.indexOf("{");
  if (start === -1) return { value: null, truncated: false };
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return { value: JSON.parse(cleaned.slice(start, i + 1)), truncated: false };
      } catch {
        return { value: null, truncated: false };
      }
    }
  }
  // Ran off the end with containers still open.
  return { value: salvage(cleaned.slice(start)), truncated: true };
}

/**
 * Rescue a cut-off plan. Losing an entire night's consolidation because the
 * last file's body got clipped is far worse than applying the entries that did
 * arrive intact: cut back to the last complete object, drop the dangling
 * comma, and close whatever is still open. A missing "index" is fine — the
 * caller rebuilds it from the files on disk.
 */
function salvage(text: string): unknown {
  // Last "}" that isn't inside a string, plus the container stack up to it.
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  let cut = -1;
  let cutStack: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      stack.pop();
      if (c === "}" && stack.length > 0) {
        cut = i;
        cutStack = [...stack];
      }
    }
  }
  if (cut === -1) return null;
  const closers = cutStack
    .reverse()
    .map((c) => (c === "{" ? "}" : "]"))
    .join("");
  try {
    return JSON.parse(text.slice(0, cut + 1) + closers);
  } catch {
    return null;
  }
}

