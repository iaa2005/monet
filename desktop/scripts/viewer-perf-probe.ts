/**
 * What is left of the viewer's own rendering rules.
 *
 * Most of what this file used to assert is gone with the code it covered: a
 * hand-written virtualized renderer (windowed rows, block tokenizing, an idle
 * scheduler, a sticky rows layer) that was measured from 6838ms down to 51ms
 * on one HTML file — and then deleted, because Monaco does the same job and
 * the things that would have come next (find, folding, editing) for free.
 *
 * Two rules survive, because they are still ours:
 *
 *   1. long markdown renders in pieces, and a piece never cuts a fenced code
 *      block in half — that turns the rest of the document into code;
 *   2. the chat's code blocks tokenize cheaply and identically whatever the
 *      nesting, since flattening the token spans is what took the viewer from
 *      841ms to 51ms and the chat inherits it.
 */

import { highlightLines } from "../src/renderer/components/chat/highlight";
import { splitMarkdownChunks } from "../src/renderer/lib/markdown-chunks";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── 1. Markdown pieces never cut a fence ──────────────────────────────
{
  const parts: string[] = [];
  for (let i = 0; i < 60; i++) {
    parts.push(`## Section ${i}`, "", "Body text ".repeat(40), "");
    parts.push("```ts", `const x${i} = ${i};`, "// ".padEnd(300, "x"), "```", "");
  }
  const doc = parts.join("\n");
  const chunks = splitMarkdownChunks(doc, 6_000);

  check("a long document is cut into pieces", chunks.length > 3, chunks.length);
  check(
    "and the pieces are the document",
    chunks.join("\n") === doc,
    `${chunks.join("\n").length} vs ${doc.length}`,
  );
  // An odd number of fences in a piece means a code block was cut in half.
  const badFence = chunks.find(
    (c) => (c.match(/^\s{0,3}(```|~~~)/gm) ?? []).length % 2 !== 0,
  );
  check("no piece ends inside a fenced code block", !badFence, badFence?.slice(0, 60));

  check(
    "a short document is left alone",
    splitMarkdownChunks("# hi\n\nshort", 6_000).length === 1,
  );
  // A document with no safe cut point at all comes back whole rather than
  // being split somewhere wrong.
  const oneFence = ["```", "x".repeat(30_000), "```"].join("\n");
  check(
    "a document with nowhere safe to cut stays whole",
    splitMarkdownChunks(oneFence, 6_000).length === 1,
  );
}

// ── 2. Highlighting is flat, and says what the source said ────────────
//
// Prism nests tokens (a tag inside a tag inside a tag) and the old walker
// rebuilt every leaf inside its ancestor stack, which put thousands of small
// styled elements on screen for one page of HTML. Flattening is why the chat
// and the viewer stopped costing hundreds of milliseconds — but a flattener
// that drops a character would be a silent corruption of what the user reads.
{
  const src = [
    "<!doctype html>",
    '<html lang="ru"><head><style>.a{color:red}</style></head>',
    '  <body><div class="card" data-id="7">Item &amp; more</div></body>',
    "</html>",
  ].join("\n");
  const lines = highlightLines(src, "markup");

  check("one entry per source line", lines.length === src.split("\n").length, lines.length);

  // Every line must still READ as itself. React nodes here are either a
  // string or an element tree of strings, so flatten and compare.
  const textOf = (node: unknown): string => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(textOf).join("");
    const el = node as { props?: { children?: unknown } } | null;
    return el?.props ? textOf(el.props.children) : "";
  };
  const rebuilt = lines.map(textOf).join("\n");
  check("the text is unchanged, character for character", rebuilt === src, `${rebuilt.length} vs ${src.length}`);

  // An unknown language must fall back to plain lines rather than throwing.
  const plain = highlightLines(src, "nosuchlang");
  check("an unknown language degrades to plain text", plain.every((l) => typeof l === "string"));
  check("and still keeps every line", plain.length === src.split("\n").length);
}

console.log(failures === 0 ? "\nALL VIEWER-PERF CHECKS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
