/**
 * Browser Use tools (Code space) — drive a managed Chrome/Edge over CDP.
 *
 * DOM-first, not pixel-first: BrowserReadPage indexes interactive elements
 * with stable refs (data-monet-ref) and returns them with the page text; the
 * model then clicks/types BY REF. Screenshots are saved to the chat's
 * artifacts (and shown in the transcript) for the user's benefit.
 *
 * The browser is a SEPARATE instance with its own profile under the app data
 * dir — the user's real browser profile is never touched.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import {
  pageClickAt,
  pageEvaluate,
  pageInfo,
  pageNavigate,
  pagePressEnter,
  pageScreenshot,
  pageScrollWheel,
  pageTypeText,
} from "../browser/page.js";

/** Element viewport rect (post scroll-into-view), or null when unresolvable. */
async function refRect(
  ref: string,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const raw = await pageEvaluate(`
    (() => {
      const el = document.querySelector('[data-monet-ref=${JSON.stringify(ref)}]');
      if (!el) return 'STALE';
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
    })()
  `);
  if (raw.includes("STALE")) return null;
  try {
    const r = JSON.parse(raw.startsWith('"') ? (JSON.parse(raw) as string) : raw) as {
      x: number; y: number; w: number; h: number;
    };
    return r;
  } catch {
    return null;
  }
}

/** A human doesn't hit the exact centre — aim inside the middle ~50% box. */
function jitteredPoint(r: { x: number; y: number; w: number; h: number }): {
  x: number;
  y: number;
} {
  const jx = (Math.random() - 0.5) * Math.min(r.w * 0.5, 60);
  const jy = (Math.random() - 0.5) * Math.min(r.h * 0.5, 24);
  return { x: r.x + r.w / 2 + jx, y: r.y + r.h / 2 + jy };
}
import { artifactReference, saveArtifactBuffer } from "../ipc/artifacts.js";

interface TextOutput {
  text: string;
  isError: boolean;
}

const mapResult = (
  content: TextOutput,
  toolUseID: string,
): ToolResultBlockParam => ({
  type: "tool_result",
  tool_use_id: toolUseID,
  content: content.text,
  is_error: content.isError || undefined,
});

const ok = (text: string): { data: TextOutput } => ({
  data: { text, isError: false },
});
const fail = (err: unknown, what: string): { data: TextOutput } => ({
  data: {
    text: `${what} failed: ${err instanceof Error ? err.message : String(err)}`,
    isError: true,
  },
});

// ─── BrowserNavigate ──────────────────────────────────────────────────────

const navSchema = lazySchema(() =>
  z.strictObject({
    url: z.string().describe("Absolute URL to open (http/https)."),
  }),
);
type NavSchema = ReturnType<typeof navSchema>;

export const BrowserNavigateTool = buildTool({
  name: "BrowserNavigate",
  searchHint: "open a URL in the managed browser",
  maxResultSizeChars: 4_000,
  get inputSchema(): NavSchema {
    return navSchema();
  },
  userFacingName() {
    return "BrowserNavigate";
  },
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },
  isOpenWorld() {
    return true;
  },
  async prompt() {
    return [
      "Open a URL in the app's managed browser (a separate Chrome/Edge window",
      "the user can watch). After navigating, call BrowserReadPage to see the",
      "page's interactive elements and text. Launching the browser on first",
      "use takes a few seconds.",
    ].join("\n");
  },
  async description() {
    return "Open a URL in the managed browser window.";
  },
  async call({ url }: z.infer<NavSchema>) {
    if (!/^https?:\/\//i.test(url))
      return { data: { text: `Invalid URL: ${url}`, isError: true } };
    try {
      const info = await pageNavigate(url);
      return ok(`Opened "${info.title}" — ${info.url}\nCall BrowserReadPage to inspect it.`);
    } catch (err) {
      return fail(err, "Navigation");
    }
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});

// ─── BrowserReadPage ──────────────────────────────────────────────────────

const READ_PAGE_SCRIPT = `
(() => {
  const out = [];
  let n = 0;
  const els = document.querySelectorAll(
    'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[contenteditable="true"]'
  );
  for (const el of els) {
    if (n >= 150) break;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const ref = 'ref' + (++n);
    el.setAttribute('data-monet-ref', ref);
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const label = (el.innerText || el.value || el.placeholder ||
      el.getAttribute('aria-label') || el.getAttribute('title') || '')
      .trim().replace(/\\s+/g, ' ').slice(0, 80);
    out.push('[' + ref + '] <' + tag + (type ? ' type=' + type : '') + '> ' + label);
  }
  const text = document.body
    ? document.body.innerText.replace(/\\n{3,}/g, '\\n\\n').slice(0, 30000)
    : '';
  return JSON.stringify({ title: document.title, url: location.href, elements: out, text });
})()
`;

const readSchema = lazySchema(() => z.strictObject({}));
type ReadSchema = ReturnType<typeof readSchema>;

export const BrowserReadPageTool = buildTool({
  name: "BrowserReadPage",
  searchHint: "read the current browser page (elements + text)",
  maxResultSizeChars: 40_000,
  get inputSchema(): ReadSchema {
    return readSchema();
  },
  userFacingName() {
    return "BrowserReadPage";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      "Read the current browser page: every interactive element gets a stable",
      "ref like [ref12] — use those refs with BrowserClick / BrowserType. The",
      "visible page text follows the element list. Re-read after anything that",
      "changes the page (navigation, click, form submit) — refs go stale.",
    ].join("\n");
  },
  async description() {
    return "List the page's interactive elements (with refs) and its visible text.";
  },
  async call() {
    try {
      const raw = await pageEvaluate(READ_PAGE_SCRIPT);
      const page = JSON.parse(raw) as {
        title: string;
        url: string;
        elements: string[];
        text: string;
      };
      return ok(
        [
          `${page.title} — ${page.url}`,
          "",
          "Interactive elements:",
          page.elements.length ? page.elements.join("\n") : "(none found)",
          "",
          "Page text:",
          page.text || "(empty)",
        ].join("\n"),
      );
    } catch (err) {
      return fail(err, "Reading the page");
    }
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});

// ─── BrowserClick ─────────────────────────────────────────────────────────

const clickSchema = lazySchema(() =>
  z.strictObject({
    ref: z.string().describe("Element ref from BrowserReadPage (e.g. ref12)."),
  }),
);
type ClickSchema = ReturnType<typeof clickSchema>;

export const BrowserClickTool = buildTool({
  name: "BrowserClick",
  searchHint: "click an element in the browser page",
  maxResultSizeChars: 4_000,
  get inputSchema(): ClickSchema {
    return clickSchema();
  },
  userFacingName() {
    return "BrowserClick";
  },
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return "Click an element by its BrowserReadPage ref. Re-read the page afterwards — the click may have changed it.";
  },
  async description() {
    return "Click a page element by ref.";
  },
  async call({ ref }: z.infer<ClickSchema>) {
    try {
      const rect = await refRect(ref);
      if (!rect)
        return {
          data: {
            text: `Ref ${ref} not found — the page changed. Call BrowserReadPage again.`,
            isError: true,
          },
        };
      if (rect.w > 1 && rect.h > 1) {
        // Real, human-paced mouse events (trusted input, pointer trail).
        await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));
        const p = jitteredPoint(rect);
        await pageClickAt(p.x, p.y);
      } else {
        // Invisible/zero-size target — fall back to a synthetic click.
        await pageEvaluate(`
          (() => {
            const el = document.querySelector('[data-monet-ref=${JSON.stringify(ref)}]');
            if (el) el.click();
            return 'OK';
          })()
        `);
      }
      await new Promise((r) => setTimeout(r, 600)); // let the page react
      const info = await pageInfo();
      return ok(`Clicked ${ref}. Now on "${info.title}" — ${info.url}`);
    } catch (err) {
      return fail(err, "Click");
    }
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});

// ─── BrowserType ──────────────────────────────────────────────────────────

const typeSchema = lazySchema(() =>
  z.strictObject({
    ref: z.string().describe("Input/textarea ref from BrowserReadPage."),
    text: z.string().describe("The text to enter (replaces current value)."),
    submit: z
      .boolean()
      .optional()
      .describe("Press Enter after typing (submit forms/search)."),
  }),
);
type TypeSchema = ReturnType<typeof typeSchema>;

export const BrowserTypeTool = buildTool({
  name: "BrowserType",
  searchHint: "type into a browser input field",
  maxResultSizeChars: 4_000,
  get inputSchema(): TypeSchema {
    return typeSchema();
  },
  userFacingName() {
    return "BrowserType";
  },
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return "Type into an input/textarea by ref with real, human-paced key events (clicks the field first, clears it, then types). Pass submit=true to press Enter afterwards.";
  },
  async description() {
    return "Type text into a page input by ref (optionally submit).";
  },
  async call({ ref, text, submit }: z.infer<TypeSchema>) {
    try {
      const rect = await refRect(ref);
      if (!rect)
        return {
          data: {
            text: `Ref ${ref} not found — the page changed. Call BrowserReadPage again.`,
            isError: true,
          },
        };
      // Focus like a person: click into the field (fallback: JS focus).
      if (rect.w > 1 && rect.h > 1) {
        const p = jitteredPoint(rect);
        await pageClickAt(p.x, p.y);
      }
      // Clear the existing value (React-compatible native setter), keep focus.
      const cleared = await pageEvaluate(`
        (() => {
          const el = document.querySelector('[data-monet-ref=${JSON.stringify(ref)}]');
          if (!el) return 'STALE';
          el.focus();
          if (el.isContentEditable) {
            el.textContent = '';
          } else {
            const proto = el.tagName === 'TEXTAREA'
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value');
            if (setter && setter.set) setter.set.call(el, '');
            else el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return 'OK';
        })()
      `);
      if (cleared.includes("STALE"))
        return {
          data: {
            text: `Ref ${ref} not found — the page changed. Call BrowserReadPage again.`,
            isError: true,
          },
        };
      // Real per-key typing with human latency.
      await new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
      await pageTypeText(text);
      if (submit) {
        await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
        await pagePressEnter();
        await new Promise((r) => setTimeout(r, 800));
      }
      return ok(`Typed into ${ref}${submit ? " and pressed Enter" : ""}.`);
    } catch (err) {
      return fail(err, "Typing");
    }
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});

// ─── BrowserScroll ────────────────────────────────────────────────────────

const scrollSchema = lazySchema(() =>
  z.strictObject({
    direction: z.enum(["down", "up"]).describe("Scroll direction."),
  }),
);
type ScrollSchema = ReturnType<typeof scrollSchema>;

export const BrowserScrollTool = buildTool({
  name: "BrowserScroll",
  searchHint: "scroll the browser page",
  maxResultSizeChars: 2_000,
  get inputSchema(): ScrollSchema {
    return scrollSchema();
  },
  userFacingName() {
    return "BrowserScroll";
  },
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return "Scroll the page one viewport up or down (for lazy-loaded content).";
  },
  async description() {
    return "Scroll the browser page.";
  },
  async call({ direction }: z.infer<ScrollSchema>) {
    try {
      // Wheel events in a few uneven ticks — like a real scroll gesture.
      const vh = Number(await pageEvaluate("String(innerHeight)")) || 800;
      await pageScrollWheel(Math.round(vh * 0.85) * (direction === "down" ? 1 : -1));
      return ok(`Scrolled ${direction}.`);
    } catch (err) {
      return fail(err, "Scroll");
    }
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});

// ─── BrowserScreenshot ────────────────────────────────────────────────────

const shotSchema = lazySchema(() => z.strictObject({}));
type ShotSchema = ReturnType<typeof shotSchema>;

export const BrowserScreenshotTool = buildTool({
  name: "BrowserScreenshot",
  searchHint: "screenshot the browser page",
  maxResultSizeChars: 4_000,
  get inputSchema(): ShotSchema {
    return shotSchema();
  },
  userFacingName() {
    return "BrowserScreenshot";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      "Capture the current browser page as a PNG. The image is attached to",
      "the chat for the USER to see; you don't receive the pixels — use",
      "BrowserReadPage for machine-readable page state.",
    ].join("\n");
  },
  async description() {
    return "Screenshot the browser page (attached to the chat).";
  },
  async call(_input: z.infer<ShotSchema>, context: ToolUseContext) {
    const sessionId =
      (context as { sessionId?: string }).sessionId || "default";
    try {
      const bytes = await pageScreenshot();
      const name = `browser-${Date.now()}.png`;
      const path = saveArtifactBuffer(sessionId, name, bytes);
      const info = await pageInfo();
      return ok(
        `[artifact] image/png ${name} :: ${artifactReference(path)}\n` +
          `Markdown: ![${name}](${artifactReference(path)})\n` +
          `Screenshot of "${info.title}" attached for the user.`,
      );
    } catch (err) {
      return fail(err, "Screenshot");
    }
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});
