/**
 * Reading the colour codes a command line writes.
 *
 * The symptom was `[32m[1mVITE[22m v8.2.0[39m` printed literally into the
 * transcript. The reason it matters beyond looking bad: Vite puts an escape
 * INSIDE the port number, so the one fact anyone wanted out of that block was
 * unreadable until the escapes were parsed.
 *
 * This is a parser for a format we do not control, and it fails in two
 * directions. Drop everything escape-shaped and the colour that made the output
 * legible goes with it. Handle only colour and leave the rest as text, and
 * cursor-movement codes end up on screen — the same garbage, less of it.
 */

import { hasAnsi, parseAnsi, stripAnsi } from "../src/renderer/lib/ansi";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
};

const E = String.fromCharCode(27);
const text = (s: string): string =>
  parseAnsi(s)
    .map((p) => p.text)
    .join("");

// ── 1. Plain text is left completely alone ────────────────────────────
{
  check("no escapes, no styling", parseAnsi("hello").length === 1);
  check("and the text is intact", text("hello") === "hello");
  check("hasAnsi says no", !hasAnsi("hello world 42"));
  check("empty is empty", parseAnsi("").length === 0);
  // A bare bracket is not an escape; matching it would eat real output.
  check("brackets alone are not escapes", !hasAnsi("array[0] = [1,2]"));
  check("and survive the parse", text("array[0] = [1,2]") === "array[0] = [1,2]");
}

// ── 2. Colour is read, and the text comes out clean ───────────────────
{
  const s = `${E}[32mgreen${E}[39m plain`;
  check("hasAnsi says yes", hasAnsi(s));
  check("the escapes are gone from the text", text(s) === "green plain", text(s));
  const spans = parseAnsi(s);
  check("the coloured run is its own span", spans[0]?.text === "green");
  check("and carries a colour", !!spans[0]?.style.color, spans[0]?.style.color);
  check("what follows does not", !spans[1]?.style.color);
}

// ── 3. Vite's real output ─────────────────────────────────────────────
//
// The escape inside the port number is the case this exists for.
{
  const vite =
    `  ${E}[32m➜${E}[39m  ${E}[1mLocal${E}[22m:   ` +
    `${E}[36mhttp://localhost:${E}[1m5174${E}[22m/${E}[39m`;
  const flat = text(vite);
  check(
    "the URL reads as one string again",
    flat.includes("http://localhost:5174/"),
    flat,
  );
  check("no escapes survive", !flat.includes(E));
  check("stripAnsi agrees with the parse", stripAnsi(vite) === flat);

  const spans = parseAnsi(vite);
  check("`Local` came back bold", spans.some((p) => p.text.includes("Local") && p.style.bold));
  check(
    "bold ends where the code said it did",
    !spans.find((p) => p.text.includes("://"))?.style.bold,
  );
}

// ── 4. Reset and partial reset ────────────────────────────────────────
{
  const spans = parseAnsi(`${E}[1;31mboth${E}[0mneither`);
  check("two attributes at once", spans[0]?.style.bold && !!spans[0]?.style.color);
  check("reset clears everything", !spans[1]?.style.bold && !spans[1]?.style.color);

  // 22 ends bold WITHOUT touching colour — a partial reset, and the one Vite
  // leans on. Clearing colour here would grey out the rest of the line.
  const partial = parseAnsi(`${E}[1;31mboth${E}[22mcolour only`);
  check("22 ends bold", !partial[1]?.style.bold);
  check("and leaves the colour", !!partial[1]?.style.color, partial[1]?.style.color);

  // An empty parameter list means reset.
  check("[m is a reset", !parseAnsi(`${E}[1mx${E}[my`)[1]?.style.bold);
}

// ── 5. 256-colour and truecolor take their arguments with them ────────
//
// Getting this wrong is loud: the numbers that belong to the colour get read
// as further attributes, so `38;5;208` turns into "bold, then colour 5".
{
  // 31 is deliberately a number that ALSO means "red" on its own: if the
  // colour's arguments are not skipped, the 31 is read as a second command and
  // silently overwrites the colour just set. 208 would not have caught it —
  // it falls in no range, so a missed skip is invisible.
  // 31 in the 6×6×6 cube is xterm's #0087af.
  const c256 = parseAnsi(`${E}[38;5;31mx`)[0]?.style;
  check("256-colour is read", c256?.color === "rgb(0 135 175)", c256?.color);
  check("its arguments are not re-read as commands", !c256?.bold && !c256?.background);

  // 100 means "bright black background" on its own — same trap, one field over.
  const rgb = parseAnsi(`${E}[38;2;255;100;0mx`)[0]?.style;
  check("truecolor is read", rgb?.color === "rgb(255 100 0)", rgb?.color);
  check(
    "its arguments are not re-read either",
    !rgb?.bold && !rgb?.background,
    rgb?.background,
  );

  const bg = parseAnsi(`${E}[48;5;21mx`)[0]?.style;
  check("48 sets the background", !!bg?.background && !bg?.color);
}

// ── 6. Everything that is not colour is removed, not printed ──────────
{
  // Progress bars redraw with cursor moves and line clears. Left in, they are
  // the same garbage the colour codes were.
  const busy = `${E}[2K${E}[1Gbuilding${E}[?25l...${E}[?25h`;
  check("cursor and clear codes vanish", text(busy) === "building...", text(busy));

  const title = `${E}]0;my title${String.fromCharCode(7)}done`;
  check("an OSC title vanishes", text(title) === "done", text(title));
  check("hasAnsi sees non-colour escapes too", hasAnsi(busy));
}

// ── 7. Runs under one style are merged ────────────────────────────────
//
// Real output wraps each coloured word in its own pair of escapes; without
// merging, one line becomes dozens of spans and React draws dozens of nodes.
{
  const s = `${E}[32ma${E}[32mb${E}[32mc`;
  check("identical styling collapses", parseAnsi(s).length === 1, parseAnsi(s).length);
  check("and keeps the text in order", text(s) === "abc");

  const changing = `${E}[32ma${E}[31mb`;
  check("a colour change does not collapse", parseAnsi(changing).length === 2);
}

console.log(failures === 0 ? "\nansi probe OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
