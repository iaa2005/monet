/**
 * The rules that keep opening a file from freezing the app.
 *
 * Reported twice, and the second time with the file: 324 lines of HTML,
 * 20 KB. In the shipped build, clicking it blocked the renderer for 6838ms —
 * measured over the DevTools protocol against the real app, because a plain
 * browser harness put the same work at 168ms and hid the problem entirely.
 *
 * Three causes, one theme: work proportional to the FILE instead of to what
 * is on screen.
 *
 *   1. tokenizing ran over the whole document, however little was displayed;
 *   2. the virtualization threshold (500 lines) was above the file that
 *      froze, so every row was in the DOM anyway;
 *   3. markdown had no windowing at all and re-rendered wholesale on any
 *      parent state change — which in the viewer is every mouse-up.
 *
 * These are the invariants that keep it fixed. They are about SHAPE, not
 * milliseconds: a timing assertion would be flaky on a loaded machine, while
 * "tokenizing a window must not touch the rest of the file" stays true.
 */

import { windowedLines, highlightLines } from "../src/renderer/components/chat/highlight";
import { splitMarkdownChunks } from "../src/renderer/lib/markdown-chunks";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A file shaped like the one that froze: markup, the most expensive grammar.
const htmlLines: string[] = ["<!doctype html>", "<html><head><style>.a{color:red}</style></head><body>"];
for (let i = 0; i < 2000; i++)
  htmlLines.push(`  <div class="card c${i}" data-id="${i}"><span>Item ${i}</span></div>`);
htmlLines.push("</body></html>");

// ── 1. A window costs a window, not a file ────────────────────────────
{
  const t0 = Date.now();
  const win = windowedLines(htmlLines, "markup", 0, 80);
  const windowMs = Date.now() - t0;

  const t1 = Date.now();
  highlightLines(htmlLines.join("\n"), "markup");
  const wholeMs = Date.now() - t1;

  check("the window returns exactly the lines asked for", win.length === 80, win.length);
  check(
    "and costs a fraction of the whole file",
    windowMs * 3 < wholeMs || wholeMs < 20,
    `window ${windowMs}ms vs whole ${wholeMs}ms`,
  );

  // Deep into the file, cold: still a window's worth of work, not a file's.
  const t2 = Date.now();
  const deep = windowedLines(htmlLines, "markup", 1500, 1580);
  const deepMs = Date.now() - t2;
  check("a window deep in the file is the same size", deep.length === 80, deep.length);
  check(
    "and does not tokenize everything before it",
    deepMs * 3 < wholeMs || wholeMs < 20,
    `${deepMs}ms`,
  );

  // Second visit: cached.
  const t3 = Date.now();
  windowedLines(htmlLines, "markup", 1500, 1580);
  check("a revisited window is free", Date.now() - t3 <= 2, `${Date.now() - t3}ms`);
}

// ── 2. Windows line up with the file ──────────────────────────────────
//
// An off-by-one here shows the wrong code under the right line number, which
// is worse than being slow.
{
  const plain = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const all = windowedLines(plain, "text", 0, plain.length);
  check("a short file comes back whole", all.length === plain.length);
  const mid = windowedLines(plain, "text", 2, 5);
  check("a slice is [start, end)", mid.length === 3, mid.length);
  const past = windowedLines(plain, "text", 6, 99);
  check("an over-long end stops at the last line", past.length === 2, past.length);
  const empty = windowedLines(plain, "text", 3, 3);
  check("an empty window renders nothing", empty.length === 0, empty.length);
}

// ── 3. Markdown pieces never cut a fence ──────────────────────────────
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
  // The rule that matters: an odd number of fences in a piece means a code
  // block was cut in half, and everything after it renders as code.
  const badFence = chunks.find(
    (c) => (c.match(/^\s{0,3}(```|~~~)/gm) ?? []).length % 2 !== 0,
  );
  check("no piece ends inside a fenced code block", !badFence, badFence?.slice(0, 60));

  check(
    "a short document is left alone",
    splitMarkdownChunks("# hi\n\nshort", 6_000).length === 1,
  );
  // A document with no cut point at all (one giant fence) must come back
  // whole rather than be split somewhere unsafe.
  const oneFence = ["```", "x".repeat(30_000), "```"].join("\n");
  check(
    "a document with nowhere safe to cut stays whole",
    splitMarkdownChunks(oneFence, 6_000).length === 1,
  );
}

console.log(failures === 0 ? "\nALL VIEWER-PERF CHECKS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
