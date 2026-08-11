/**
 * The browser pane's <webview> really carries `allowpopups`.
 *
 * Not a style question — it is the difference between a working sign-in and a
 * dead click. Without the attribute ON THE ELEMENT, Chromium blocks every
 * window.open in the pane before any of our code runs: the call returns null,
 * main's setWindowOpenHandler is never consulted, and a page that opens its
 * login in a popup (Google, and every OAuth flow like it) shows a spinner for
 * ever with no window and nothing in any log.
 *
 * It was written `<webview allowpopups />`, which reads as correct and is not:
 * `webview` has no dash in its name, so React treats it as an unknown HTML
 * element rather than a custom one, and a bare JSX boolean on one of those is
 * DROPPED — React says so itself ("Received `true` for a non-boolean attribute
 * `allowpopups`… pass a string instead"). The rendered element simply had no
 * attribute, and the popup handler in main was correct and unreachable for as
 * long as that was true.
 *
 * So this renders the REAL component and looks at the markup, rather than
 * trusting the source to mean what it says.
 *
 *   npm run smoke:webviewpopups
 */

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(
      `FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
    );
  }
}

// browser-store reads these at import time in some builds; harmless stubs.
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { BrowserView } = await import("@/components/browser/BrowserView");

// ─── The rule that broke it, pinned ─────────────────────────────────────
//
// If React ever starts honouring the bare boolean, this goes green on its own
// and the string below stops being load-bearing — but until then it is.
{
  const bare = renderToStaticMarkup(
    createElement("webview", {
      src: "https://example.com",
      allowpopups: true,
    } as never),
  );
  check(
    "REACT DROPS A BARE BOOLEAN allowpopups — this is why the string is needed",
    !/allowpopups/.test(bare),
    bare,
  );
  const str = renderToStaticMarkup(
    createElement("webview", {
      src: "https://example.com",
      allowpopups: "true",
    } as never),
  );
  check("…and keeps a string one", /allowpopups="true"/.test(str), str);
}

// ─── What the pane actually renders ─────────────────────────────────────

{
  const markup = renderToStaticMarkup(
    createElement(BrowserView as never, {
      tab: { id: "t1", url: "https://example.com", title: "", loading: false },
      partition: "persist:monet-browser-test",
      active: true,
    } as never),
  );

  check(
    "THE PANE'S WEBVIEW CARRIES allowpopups — without it every popup is blocked",
    /allowpopups=/.test(markup),
    markup.slice(0, 300),
  );
  check(
    "…as a value the DOM keeps, not an empty boolean React discards",
    /allowpopups="true"/.test(markup),
    markup.slice(0, 300),
  );
  check(
    "…on the same element that gets the partition",
    /<webview[^>]*allowpopups[^>]*>/.test(markup) &&
      /<webview[^>]*partition="persist:monet-browser-test"[^>]*>/.test(markup),
    markup.slice(0, 300),
  );
}

console.log(
  failures ? `\n${failures} FAILED` : "\nPOPUPS CAN LEAVE THE PANE",
);
process.exit(failures ? 1 : 0);
