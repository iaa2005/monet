/**
 * Separating what the model reads from what the user reads.
 *
 * A message that pointed at an element carries both: the sentence, and forty
 * lines describing the element. Drawing the second one made "make this centred"
 * look like a stack trace, so it is hidden — and hiding is where this gets
 * dangerous. Every failure here is SILENT:
 *
 *  - Editing a message shows the sentence. If the blocks do not come back on
 *    save, the agent is re-run with the instruction and no idea what "this"
 *    was, and nothing anywhere says so.
 *  - The ⟨token⟩ IS the reference. If deleting one does not drop its context,
 *    the model gets told about an element the sentence no longer mentions.
 *  - Two selections can share a label. Matching by name instead of by count
 *    sends the wrong one, or both.
 */

import {
  hasSelections,
  insertRefToken,
  joinSelections,
  labelOf,
  refToken,
  splitSelections,
  tokenBefore,
  usedRefs,
} from "../src/renderer/lib/selection-marks";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
};

const block = (opts: { component?: string; element?: string; url?: string }) =>
  [
    "<selected-from-browser>",
    `page: Портфолио — ${opts.url ?? "http://localhost:5173/"}`,
    "viewport: 662×978 @1.75x",
    "",
    `element 1: ${opts.element ?? "section#home.hero"}`,
    ...(opts.component ? [`component: <${opts.component}>`] : []),
    'text: "Привет, меня зовут"',
    "selector: #home",
    "xpath: /body/div[1]/section[1]",
    "styles: display: flex; align-items: center",
    "likely source files: src/main.js",
    "</selected-from-browser>",
  ].join("\n");

// ── 1. The block comes out, the sentence stays ────────────────────────
{
  const content = `сделать align center ${refToken("Hero")}\n\n${block({ component: "Hero" })}`;
  const { text, refs } = splitSelections(content);

  check("the sentence survives", text === "сделать align center ⟨Hero⟩", text);
  check("nothing of the block is left", !text.includes("selected-from-browser"));
  check("no styles leak into the sentence", !text.includes("align-items"));
  check("one ref came out", refs.length === 1);
  check("labelled by its component", refs[0]?.label === "Hero", refs[0]?.label);
  check(
    "and carries the page it came from",
    refs[0]?.url === "http://localhost:5173/",
    refs[0]?.url,
  );
  check("the raw block is kept verbatim", refs[0]?.raw === block({ component: "Hero" }));
}

// ── 2. Without a component, the element names it ──────────────────────
{
  const { refs } = splitSelections(`x\n\n${block({ element: "section#home.hero" })}`);
  check(
    "falls back to the element line",
    refs[0]?.label === "section#home.hero",
    refs[0]?.label,
  );
  check("labelOf on a bare string agrees", labelOf(block({})) === "section#home.hero");
  check("a block with neither still gets a name", labelOf("<selected-from-browser>\n</selected-from-browser>") === "selection");
}

// ── 3. The edit round trip is lossless ────────────────────────────────
{
  const original = `сделать align center ${refToken("Hero")}\n\n${block({ component: "Hero" })}`;
  const { text, refs } = splitSelections(original);

  // Saved unchanged.
  const rejoined = joinSelections(text, usedRefs(text, refs, (r) => r.label));
  check("split then join gives the message back", rejoined === original, rejoined);

  // Edited, reference kept.
  const edited = `сделать align center и побольше ${refToken("Hero")}`;
  const keptRefs = usedRefs(edited, refs, (r) => r.label);
  check("an edit that keeps the token keeps the context", keptRefs.length === 1);
  const saved = joinSelections(edited, keptRefs);
  check("and the block rides along", saved.includes("selector: #home"));
  check(
    "re-splitting the saved message is stable",
    splitSelections(saved).text === edited,
    splitSelections(saved).text,
  );

  // Edited, reference deleted.
  const dropped = "сделать align center";
  check(
    "deleting the token drops the context",
    usedRefs(dropped, refs, (r) => r.label).length === 0,
  );
  check(
    "and the saved message carries none",
    !hasSelections(joinSelections(dropped, usedRefs(dropped, refs, (r) => r.label))),
  );
}

// ── 4. Two selections, one label ──────────────────────────────────────
{
  const refs = [
    { label: "Row", raw: block({ component: "Row" }), url: "" },
    { label: "Row", raw: block({ component: "Row", url: "http://x/" }), url: "" },
    { label: "Toggle", raw: block({ component: "Toggle" }), url: "" },
  ];

  const both = `сравни ${refToken("Row")} и ${refToken("Row")}`;
  check("two tokens keep two refs", usedRefs(both, refs, (r) => r.label).length === 2);

  const one = `посмотри ${refToken("Row")}`;
  const kept = usedRefs(one, refs, (r) => r.label);
  check("one token keeps exactly one", kept.length === 1);
  check("and it is the first of that label", kept[0] === refs[0]);

  const mixed = `${refToken("Toggle")} внутри ${refToken("Row")}`;
  const mixedKept = usedRefs(mixed, refs, (r) => r.label);
  check("labels are matched independently", mixedKept.length === 2, mixedKept.length);
  check(
    "order follows the ref list, not the text",
    mixedKept[0]?.label === "Row" && mixedKept[1]?.label === "Toggle",
    mixedKept.map((r) => r.label).join(","),
  );
}

// ── 5. Several blocks in one message ──────────────────────────────────
{
  const content = [
    `${refToken("Row")} и ${refToken("Toggle")}`,
    block({ component: "Row" }),
    block({ component: "Toggle" }),
  ].join("\n\n");
  const { text, refs } = splitSelections(content);
  check("both blocks are pulled out", refs.length === 2);
  check("in the order they appeared", refs.map((r) => r.label).join(",") === "Row,Toggle");
  check("the sentence is clean", text === "⟨Row⟩ и ⟨Toggle⟩", text);
  check(
    "and the round trip still holds",
    joinSelections(text, refs) === content,
  );
}

// ── 6. Inserting a token reads like a word ────────────────────────────
{
  const empty = insertRefToken("", "Hero", 0);
  check("into an empty box, no stray spaces", empty.text === "⟨Hero⟩", empty.text);
  check("caret lands after it", empty.caret === "⟨Hero⟩".length);

  const after = insertRefToken("сделать", "Hero", 7);
  check("a space is added before it", after.text === "сделать ⟨Hero⟩", after.text);

  const between = insertRefToken("до после", "Hero", 3);
  check("and after it, mid-sentence", between.text === "до ⟨Hero⟩ после", between.text);
  check(
    "the caret sits just past the token",
    between.text.slice(0, between.caret) === "до ⟨Hero⟩",
    between.text.slice(0, between.caret),
  );

  const spaced = insertRefToken("до ", "Hero", 3);
  check("an existing space is not doubled", spaced.text === "до ⟨Hero⟩", spaced.text);

  const clamped = insertRefToken("abc", "Hero", 999);
  check("a caret past the end is clamped", clamped.text === "abc ⟨Hero⟩", clamped.text);
}

// ── 7. Backspace eats the whole token ─────────────────────────────────
{
  const text = "до ⟨Hero⟩ после";
  const end = text.indexOf("⟩") + 1;
  const hit = tokenBefore(text, end);
  check("just past a token, the whole token is found", !!hit, JSON.stringify(hit));
  check(
    "removing it leaves the rest intact",
    hit ? text.slice(0, hit.start) + text.slice(hit.end) === "до  после" : false,
  );
  check("in the middle of a word, nothing is found", tokenBefore(text, 2) === null);
  check("at position zero, nothing is found", tokenBefore(text, 0) === null);
  check(
    "brackets across a newline are not a pair",
    tokenBefore("⟨Hero\nstuff⟩", "⟨Hero\nstuff⟩".length) === null,
  );
  check(
    "a lone closing bracket is not a token",
    tokenBefore("just ⟩", 6) === null,
    JSON.stringify(tokenBefore("just ⟩", 6)),
  );
}

// ── 8. A message with no selections is left completely alone ──────────
{
  const plain = "обычное сообщение\n\nсо вторым абзацем";
  const { text, refs } = splitSelections(plain);
  check("text untouched", text === plain, text);
  check("no refs", refs.length === 0);
  check("hasSelections says no", !hasSelections(plain));
  check("join with nothing is a no-op", joinSelections(plain, []) === plain);
}

console.log(failures === 0 ? "\nselection marks probe OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
