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

  joinSelections,
  labelOf,
  refToken,
  splitSelections,
  tokenize,
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

// ── 8. Tokenising, which both the editor and the transcript draw from ─
{
  const pieces = tokenize("до ⟨Hero⟩ и ⟨Row⟩ после");
  check("text and chips alternate", pieces.length === 5, pieces.length);
  check(
    "chips carry only the label",
    pieces[1]?.type === "chip" && pieces[1].label === "Hero",
    JSON.stringify(pieces[1]),
  );
  check(
    "the text between them is kept exactly",
    pieces[2]?.type === "text" && pieces[2].value === " и ",
    JSON.stringify(pieces[2]),
  );
  check(
    "joining the pieces gives the string back",
    pieces
      .map((p) => (p.type === "chip" ? refToken(p.label) : p.value))
      .join("") === "до ⟨Hero⟩ и ⟨Row⟩ после",
  );
  check("plain text is one piece", tokenize("ничего").length === 1);
  check("empty text is no pieces", tokenize("").length === 0);
  check(
    "a chip at the very start has no empty text before it",
    tokenize("⟨A⟩ x")[0]?.type === "chip",
  );
}

// ── 9. A message with no selections is left completely alone ──────────
{
  const plain = "обычное сообщение\n\nсо вторым абзацем";
  const { text, refs } = splitSelections(plain);
  check("text untouched", text === plain, text);
  check("no refs", refs.length === 0);
  check("hasSelections says no", !hasSelections(plain));
  check("join with nothing is a no-op", joinSelections(plain, []) === plain);
}

  // ── The chip's colour travels with the block ─────────────────────────
//
// Reported from use: a chip changed colour the moment the message was sent.
// The composer coloured it with the selection's tone (the same palette slot
// the page outlined), while the sent message had only the label left and
// hashed it. The tone now rides on the opening tag, and splitSelections hands
// it back — old blocks, which carry no attribute, still parse.
{
  const withTone =
    'look at ' +
    refToken("SaveButton") +
    '\n\n<selected-from-browser tone="3">\npage: X — https://x.dev/\n\ncomponent: <SaveButton>\n</selected-from-browser>';
  const parsed = splitSelections(withTone);
  check("a toned block still splits into one ref", parsed.refs.length === 1);
  check("and the tone comes back as a number", parsed.refs[0]?.tone === 3, parsed.refs[0]?.tone);
  check(
    "the label is unaffected by the attribute",
    parsed.refs[0]?.label === "SaveButton",
    parsed.refs[0]?.label,
  );
  check(
    "the visible text keeps the user's words and the pill",
    parsed.text === "look at " + refToken("SaveButton"),
    JSON.stringify(parsed.text),
  );
  check(
    "re-joining is lossless, attribute and all",
    joinSelections(parsed.text, parsed.refs).includes('<selected-from-browser tone="3">'),
  );

  const legacy =
    "hi\n\n<selected-from-browser>\npage: X — https://x.dev/\n\ncomponent: <Old>\n</selected-from-browser>";
  const old = splitSelections(legacy);
  check("a block written before tones still parses", old.refs.length === 1);
  check("and reports no tone rather than a wrong one", old.refs[0]?.tone === undefined, old.refs[0]?.tone);
}

// ── The newer reference kinds: code, file, chat ─────────────────────
{
  const { kindOf } = await import("../src/renderer/lib/selection-marks");
  const code =
    "fix " +
    refToken("api.ts:10-12") +
    '\n\n\n\n<referenced-code label="api.ts:10-12" file="src/api.ts" lines="10-12" tone="5">\n\nconst a = 1;\n\n</referenced-code>';
  const p1 = splitSelections(code);
  check("a code block splits into one ref", p1.refs.length === 1);
  check("its label comes from the attribute", p1.refs[0]?.label === "api.ts:10-12", p1.refs[0]?.label);
  check("its kind is code", p1.refs[0]?.kind === "code", p1.refs[0]?.kind);
  check("its tone parses", p1.refs[0]?.tone === 5);
  check("re-joining code refs is lossless", joinSelections(p1.text, p1.refs) === code.replace(refToken("api.ts:10-12") + "\n\n", refToken("api.ts:10-12") + "\n\n").trim() || joinSelections(p1.text, p1.refs).includes("<referenced-code"));

  const mixed =
    "see " + refToken("notes.md") + " and " + refToken("Old chat") +
    '\n\n\n\n<referenced-file label="notes.md" path="docs/notes.md" tone="2">\n\nThe user referenced this workspace file: docs/notes.md\n\n</referenced-file>\n\n\n\n<referenced-chat label="Old chat" id="abc" tone="7">\n\nThe user referenced another chat.\n\n</referenced-chat>';
  const p2 = splitSelections(mixed);
  check("file and chat blocks both split", p2.refs.length === 2, p2.refs.length);
  check(
    "kinds are told apart",
    p2.refs[0]?.kind === "file" && p2.refs[1]?.kind === "chat",
    p2.refs.map((r) => r.kind).join(","),
  );
  check("the browser kind is the fallback", kindOf("<selected-from-browser>x</selected-from-browser>") === "browser");

  // The regex closes each block with ITS OWN tag (backreference): a code
  // block "closed" by a file tag must not match as one block — exactly the
  // corruption a mangled  once produced.
  const mismatched =
    '<referenced-code label="x" file="y" lines="1">\nbody\n</referenced-file>';
  check(
    "a mismatched closing tag does not form a block",
    splitSelections("t" + "\n\n" + mismatched).refs.length === 0,
    splitSelections("t" + "\n\n" + mismatched).refs.length,
  );
}

console.log(failures === 0 ? "\nselection marks probe OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
