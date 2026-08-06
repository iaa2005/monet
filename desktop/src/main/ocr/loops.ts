/**
 * Cutting a model off when it starts repeating itself.
 *
 * Every model here has done it, on a different page each time: SmolDocling
 * emitted "Царнир" fifty times, Qwen3-VL wrote
 * "| Кубитовая оптическая | 0.02 | 0.02 |" until it hit the token cap.
 * A block that loops costs the whole per-block budget — thirty seconds
 * spent on a paragraph that ended after two lines — and then prints the
 * loop into the user's note.
 *
 * The rule is deliberately blunt: a line repeated several times in a row is
 * a loop. A real document does repeat lines — a column of "0.02" in a table
 * is legitimate — so a REPEATED LINE alone is not enough; it has to repeat
 * more times than a table plausibly would, and the block keeps everything
 * before the repetition started.
 */

/** How many identical lines in a row count as a loop rather than a table. */
const RUN_LIMIT = 4;

/**
 * Trim a runaway tail.
 *
 * Returns the text up to where it started repeating, and whether anything
 * was cut — the caller may want to say so rather than pretend the block
 * ended naturally.
 */
export function trimLoop(text: string): { text: string; looped: boolean } {
  const lines = text.split("\n");
  let run = 1;
  for (let i = 1; i < lines.length; i++) {
    const same = lines[i].trim() !== "" && lines[i].trim() === lines[i - 1].trim();
    run = same ? run + 1 : 1;
    if (run > RUN_LIMIT) {
      // Keep the first occurrence, drop the rest.
      return { text: lines.slice(0, i - RUN_LIMIT + 1).join("\n").trimEnd(), looped: true };
    }
  }

  // A two-line loop ("a\nb\na\nb\n…") is just as common and slips past a
  // run of identical lines.
  for (let period = 2; period <= 3; period++) {
    let repeats = 1;
    for (let i = period; i + period <= lines.length; i += period) {
      const a = lines.slice(i - period, i).join("\n").trim();
      const b = lines.slice(i, i + period).join("\n").trim();
      if (a !== "" && a === b) {
        repeats++;
        if (repeats > RUN_LIMIT)
          return {
            text: lines.slice(0, i).join("\n").trimEnd(),
            looped: true,
          };
      } else repeats = 1;
    }
  }

  return { text, looped: false };
}
