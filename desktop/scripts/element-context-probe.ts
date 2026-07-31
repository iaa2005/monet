/**
 * What a clicked element turns into.
 *
 * The value of design mode is not that the model gets a description — it is
 * that the model finds the CODE. Which makes the ranking of search terms the
 * load-bearing part, and it is easy to get backwards:
 *
 *  - Visible text beats a component name. A build renames `SaveButton` to `t`;
 *    "Save changes" appears in the source exactly as it does on screen.
 *  - A utility class is not a search term. In a Tailwind app the first class
 *    on almost every element is `flex` or `px-4`, and grepping for that
 *    returns the whole repo — worse than returning nothing, because it looks
 *    like an answer.
 *
 * The formatting is asserted too: it is the text the model reads, and a props
 * blob that carries a function or an unbounded string is how a selection ends
 * up costing more than the conversation around it.
 */

import {
  formatElement,
  formatSelection,
  searchTermsFor,
  summarizeElement,
  type RawElement,
  type SelectionPayload,
} from "../src/main/browser/element-context";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
};

const el = (over: Partial<RawElement> = {}): RawElement => ({
  xpath: "/body/div[1]/main/button[2]",
  selector: "main > div.card > button.btn",
  tag: "button",
  rect: { x: 412, y: 284, w: 132, h: 40 },
  pageRect: { x: 412, y: 684, w: 132, h: 40 },
  ...over,
});

// ── 1. Search terms are ranked, not just collected ────────────────────
{
  const terms = searchTermsFor(
    el({ text: "Save changes", component: "SaveButton", id: "save-btn" }),
  );
  check("visible text is tried first", terms[0] === "Save changes", terms.join(" | "));
  check("component name is second", terms[1] === "SaveButton", terms.join(" | "));
  check("id comes after both", terms[2] === "save-btn", terms.join(" | "));
}

// ── 2. Tailwind noise is not a search term ────────────────────────────
{
  const tailwind = el({
    classes: [
      "flex", "items-center", "gap-2", "rounded-md", "px-3", "py-1.5",
      "text-sm", "font-medium", "hover:bg-black/[0.06]", "dark:bg-white/[0.08]",
      "size-4", "transition-colors",
    ],
  });
  check(
    "an all-utility class list yields no term",
    searchTermsFor(tailwind).length === 0,
    searchTermsFor(tailwind).join(" | "),
  );

  const mixed = el({ classes: ["flex", "px-3", "workspace-picker", "text-sm"] });
  check(
    "a real class survives among utilities",
    searchTermsFor(mixed)[0] === "workspace-picker",
    searchTermsFor(mixed).join(" | "),
  );
}

// ── 3. Terms that cannot identify anything are dropped ────────────────
{
  check("a number is not a term", searchTermsFor(el({ text: "42" })).length === 0);
  check("two characters is not a term", searchTermsFor(el({ text: "OK" })).length === 0);
  check(
    "a paragraph is not a term",
    searchTermsFor(el({ text: "x".repeat(200) })).length === 0,
  );
  check(
    "a lowercase component name is not one",
    searchTermsFor(el({ component: "div" })).length === 0,
  );
  check(
    "duplicates collapse",
    searchTermsFor(el({ text: "Header", component: "Header" })).length === 1,
  );
}

// ── 4. The chip label names the most specific thing known ─────────────
{
  // No angle brackets: the label becomes a ⟨token⟩ the user types around.
  check(
    "component wins the label",
    summarizeElement(el({ component: "SaveButton", classes: ["btn"], text: "Save" })) ===
      "SaveButton",
    summarizeElement(el({ component: "SaveButton", classes: ["btn"], text: "Save" })),
  );
  check(
    "then a real class",
    summarizeElement(el({ classes: ["flex", "card-actions"], text: "Save" })) ===
      "button.card-actions",
    summarizeElement(el({ classes: ["flex", "card-actions"], text: "Save" })),
  );
  check(
    "then the text",
    summarizeElement(el({ classes: ["flex"], text: "Save changes" })) ===
      'button "Save changes"',
    summarizeElement(el({ classes: ["flex"], text: "Save changes" })),
  );
  const long = summarizeElement(el({ text: "x".repeat(80) }));
  check("long text is cut short", long.includes("…") && long.length < 40, long);
  check("bare tag is the floor", summarizeElement(el()) === "button");
}

// ── 5. The block carries what the model needs to act ──────────────────
{
  const block = formatElement(
    el({
      id: "save",
      classes: ["btn", "btn-primary"],
      text: "Save changes",
      component: "SaveButton",
      framework: "react",
      source: "src/components/SaveButton.tsx:42",
      styles: {
        display: "flex",
        "background-color": "rgb(37, 99, 235)",
        "border-radius": "8px",
        // Defaults carry no information and cost tokens on every selection.
        "letter-spacing": "normal",
        "box-shadow": "none",
      },
      attrs: { type: "submit", "aria-label": "Save" },
      parent: "div.card-actions",
      siblingCount: 2,
      props: {
        variant: "primary",
        disabled: false,
        onClick: () => undefined,
        children: "Save changes",
      },
    }),
    1,
    ["src/components/SaveButton.tsx"],
  );

  for (const needle of [
    "component: <SaveButton> (react)",
    "source: src/components/SaveButton.tsx:42",
    "selector: main > div.card > button.btn",
    "xpath: /body/div[1]/main/button[2]",
    "box: 132×40 at (412, 284)",
    "parent: div.card-actions (2 children)",
    "likely source files: src/components/SaveButton.tsx",
  ]) {
    check(`block states "${needle.split(":")[0]}"`, block.includes(needle), needle);
  }

  check("a function prop is not serialised", block.includes("onClick=fn"), block);
  check(
    "children is left out of props",
    !/props:.*children/.test(block),
    /props:.*/.exec(block)?.[0],
  );
  check(
    "default style values are dropped",
    !block.includes("letter-spacing") && !block.includes("box-shadow"),
    /styles:.*/.exec(block)?.[0],
  );
  check(
    "real style values are kept",
    block.includes("background-color: rgb(37, 99, 235)"),
  );
}

// ── 6. Long values are capped ─────────────────────────────────────────
{
  const block = formatElement(
    el({
      text: "y".repeat(1000),
      selector: "s".repeat(1000),
      props: { blob: "z".repeat(1000) },
    }),
    1,
  );
  check("the block does not run away", block.length < 1200, block.length);
  check("truncation is marked", block.includes("…"));
}

// ── 7. The selection is tagged, so the model can tell it from the user ─
{
  const payload: SelectionPayload = {
    url: "http://localhost:17173/settings",
    title: "Settings",
    viewport: { w: 1280, h: 800, dpr: 2 },
    elements: [el({ component: "Row" }), el({ component: "Toggle" })],
  };
  const out = formatSelection(payload, { 0: ["src/Row.tsx"] });

  check("opens and closes a tag", out.startsWith("<selected-from-browser>"));
  check("closes the tag", out.trim().endsWith("</selected-from-browser>"));
  check("names the page", out.includes("http://localhost:17173/settings"));
  check("records the dpr", out.includes("1280×800 @2x"), /viewport:.*/.exec(out)?.[0]);
  check("numbers both elements", out.includes("element 1:") && out.includes("element 2:"));
  check(
    "says a multi-selection is about the relationship",
    out.includes("selected these together"),
  );
  check(
    "a single selection says no such thing",
    !formatSelection({ ...payload, elements: [el()] }).includes("selected these together"),
  );

  const region = formatSelection({
    ...payload,
    elements: [],
    region: { x: 100, y: 200, w: 300, h: 150 },
  });
  check("a marked region is described", region.includes("region marked: 300×150"), region);
}

console.log(failures === 0 ? "\nelement context probe OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
