/**
 * Browser tools — one page, ten verbs.
 *
 * DOM-first, not pixel-first: BrowserReadPage indexes interactive elements with
 * stable refs (REF_ATTR in shared/brand.ts) and returns them with the page text; the model
 * clicks and types BY REF. Coordinates are an implementation detail of making
 * the click look human.
 *
 * Three choices are here for the benefit of a model that is not very good:
 *
 *  - There is no BrowserWaitFor. Waiting is built into the acting tools, so
 *    the model cannot forget it and read a page mid-navigation.
 *  - Console and network go to FILES. Every tool result carries a one-line
 *    count instead of the traffic itself, and BrowserLogs reads what is asked
 *    for. A React dev build warns a dozen times on first paint; paying for
 *    that on every click buries the error that matters.
 *  - Every failure names the next move ("the page changed — call
 *    BrowserReadPage again") rather than describing what went wrong.
 *
 * Which browser this drives — the panel beside the chat, or a separate Chrome —
 * is the user's setting; see browser/transport.ts.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "./lazy-schema.js";
import {
  pageClickAt,
  pageEvaluate,
  pageInfo,
  pageNavigate,
  pagePressEnter,
  pageScreenshot,
  pageHistory,
  pageScrollWheel,
  pageSetViewport,
  pageSettle,
  pageTargetId,
  pageTypeText,
} from "../browser/page.js";
import { logPath, logSummary, readLog } from "../browser/logs.js";
import { listTabs, setActiveTab, tabContents } from "../browser/registry.js";
import { getBrowserConfig } from "../browser/config.js";
import { activeModelAccepts } from "./model-modalities.js";
import { artifactReference, saveArtifactBuffer } from "../ipc/artifacts.js";
import { REF_ATTR } from "@shared/brand.js";

interface TextOutput {
  text: string;
  isError: boolean;
  imageBase64?: string;
  imageMediaType?: string;
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
const stale = (ref: string): { data: TextOutput } => ({
  data: {
    text: `Ref ${ref} is not on the page any more — it changed. Call BrowserReadPage to get current refs.`,
    isError: true,
  },
});

/** "console: 2 errors in 31 messages" appended to a result, when there is any. */
async function traffic(): Promise<string> {
  try {
    const summary = logSummary(await pageTargetId());
    return summary ? `\n${summary} — BrowserLogs to read them.` : "";
  } catch {
    return "";
  }
}

/** Element viewport rect (post scroll-into-view), or null when unresolvable. */
async function refRect(
  ref: string,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const raw = await pageEvaluate(`
    (() => {
      const el = document.querySelector('[${REF_ATTR}=${JSON.stringify(ref)}]');
      if (!el) return 'STALE';
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
    })()
  `);
  if (raw.includes("STALE")) return null;
  try {
    return JSON.parse(raw.startsWith('"') ? (JSON.parse(raw) as string) : raw) as {
      x: number;
      y: number;
      w: number;
      h: number;
    };
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

// ─── BrowserNavigate ──────────────────────────────────────────────────────

const navSchema = lazySchema(() =>
  z.strictObject({
    url: z
      .string()
      .optional()
      .describe("Absolute URL to open (http/https). Omit when using `action`."),
    action: z
      .enum(["back", "forward", "reload"])
      .optional()
      .describe("Move through history instead of opening a URL."),
    newTab: z
      .boolean()
      .optional()
      .describe(
        "Open in a NEW tab instead of reusing the current one, so the page you were on stays open. Use when you need two sites at once (compare, or keep a reference while working). BrowserTabs lists them and switches between them.",
      ),
  }),
);
type NavSchema = ReturnType<typeof navSchema>;

export const BrowserNavigateTool = buildTool({
  name: "BrowserNavigate",
  searchHint: "open a URL in the browser panel",
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
      "Open a URL in the browser the user can watch, or move through history",
      "with action=back/forward/reload. Opens the Browser panel if it is closed.",
      "Waits for the page to finish loading before returning, so you can call",
      "BrowserReadPage straight afterwards.",
      "",
      "Pass newTab: true to open it BESIDE the current page rather than",
      "replacing it — that is how you keep two sites open at once. Do not try",
      "window.open through BrowserEval: a scripted open is not a user gesture",
      "and the popup blocker stops it.",
      "",
      "If the user is running a dev server, prefer its localhost URL over a",
      "production one — that is the app they are editing.",
    ].join("\n");
  },
  async description() {
    return "Open a URL, or go back/forward/reload.";
  },
  async call({ url, action, newTab }: z.infer<NavSchema>) {
    try {
      if (action) {
        await pageHistory(action);
        await pageSettle();
        const info = await pageInfo();
        return ok(`Went ${action}. Now on "${info.title}" — ${info.url}${await traffic()}`);
      }
      if (!url || !/^https?:\/\//i.test(url))
        return {
          data: {
            text: `Invalid URL: ${url ?? "(none)"}. Pass an absolute http(s) URL, or use action.`,
            isError: true,
          },
        };
      const info = await pageNavigate(url, newTab === true);
      await pageSettle();
      return ok(
        `Opened "${info.title}"${newTab ? " in a new tab" : ""} — ${info.url}\n` +
          `Call BrowserReadPage to see what is on it.${await traffic()}`,
      );
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
    el.setAttribute('${REF_ATTR}', ref);
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const label = (el.innerText || el.value || el.placeholder ||
      el.getAttribute('aria-label') || el.getAttribute('title') || '')
      .trim().replace(/\\s+/g, ' ').slice(0, 80);
    const off = r.bottom < 0 || r.top > innerHeight ? ' (off-screen)' : '';
    const state = el.disabled ? ' (disabled)' : '';
    out.push('[' + ref + '] <' + tag + (type ? ' type=' + type : '') + '> ' + label + state + off);
  }
  const text = document.body
    ? document.body.innerText.replace(/\\n{3,}/g, '\\n\\n').slice(0, 30000)
    : '';
  return JSON.stringify({
    title: document.title, url: location.href, elements: out, text,
    vw: innerWidth, vh: innerHeight,
    scroll: Math.round(scrollY), height: Math.round(document.body ? document.body.scrollHeight : 0)
  });
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
      "Read the current page: every interactive element gets a stable ref like",
      "[ref12] — use those refs with BrowserClick and BrowserType. The visible",
      "page text follows the element list.",
      "",
      "Refs go stale whenever the page changes. Anything that navigates or",
      "re-renders means reading again before the next click.",
    ].join("\n");
  },
  async description() {
    return "List the page's interactive elements (with refs) and its visible text.";
  },
  async call() {
    try {
      const page = JSON.parse(await pageEvaluate(READ_PAGE_SCRIPT)) as {
        title: string;
        url: string;
        elements: string[];
        text: string;
        vw: number;
        vh: number;
        scroll: number;
        height: number;
      };
      const more =
        page.height > page.scroll + page.vh + 40
          ? `  (${page.height - page.scroll - page.vh}px more below — BrowserScroll)`
          : "";
      return ok(
        [
          `${page.title} — ${page.url}`,
          `viewport ${page.vw}×${page.vh}, scrolled to ${page.scroll}${more}`,
          "",
          "Interactive elements:",
          page.elements.length ? page.elements.join("\n") : "(none found)",
          "",
          "Page text:",
          page.text || "(empty)",
        ].join("\n") + (await traffic()),
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
    return [
      "Click an element by its BrowserReadPage ref. Waits for the page to",
      "settle afterwards. The click may have changed the page, so read it again",
      "before the next ref-based call.",
    ].join("\n");
  },
  async description() {
    return "Click a page element by ref.";
  },
  async call({ ref }: z.infer<ClickSchema>) {
    try {
      const rect = await refRect(ref);
      if (!rect) return stale(ref);
      if (rect.w > 1 && rect.h > 1) {
        // Real, human-paced mouse events (trusted input, pointer trail).
        await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));
        const p = jitteredPoint(rect);
        await pageClickAt(p.x, p.y);
      } else {
        // Invisible/zero-size target — fall back to a synthetic click.
        await pageEvaluate(`
          (() => {
            const el = document.querySelector('[${REF_ATTR}=${JSON.stringify(ref)}]');
            if (el) el.click();
            return 'OK';
          })()
        `);
      }
      await pageSettle();
      const info = await pageInfo();
      return ok(`Clicked ${ref}. Now on "${info.title}" — ${info.url}${await traffic()}`);
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
    return [
      "Type into an input or textarea by ref: clicks the field, clears it, then",
      "types with real key events. Pass submit=true to press Enter afterwards.",
      "",
      "Never type credentials, card numbers or other secrets — ask the user to",
      "enter those themselves.",
    ].join("\n");
  },
  async description() {
    return "Type text into a page input by ref (optionally submit).";
  },
  async call({ ref, text, submit }: z.infer<TypeSchema>) {
    try {
      const rect = await refRect(ref);
      if (!rect) return stale(ref);
      // Focus like a person: click into the field (fallback: JS focus).
      if (rect.w > 1 && rect.h > 1) {
        const p = jitteredPoint(rect);
        await pageClickAt(p.x, p.y);
      }
      // Clear the existing value (React-compatible native setter), keep focus.
      const cleared = await pageEvaluate(`
        (() => {
          const el = document.querySelector('[${REF_ATTR}=${JSON.stringify(ref)}]');
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
      if (cleared.includes("STALE")) return stale(ref);
      // Real per-key typing with human latency.
      await new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
      await pageTypeText(text);
      if (submit) {
        await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
        await pagePressEnter();
        await pageSettle();
      }
      return ok(`Typed into ${ref}${submit ? " and pressed Enter" : ""}.${await traffic()}`);
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
    direction: z
      .enum(["down", "up", "top", "bottom"])
      .optional()
      .describe("Scroll the page. Default: down."),
    ref: z
      .string()
      .optional()
      .describe("Scroll this element into view instead."),
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
    return "Scroll the page one viewport up or down, jump to top/bottom, or bring one element into view. Use it for lazy-loaded content that BrowserReadPage reported as below the fold.";
  },
  async description() {
    return "Scroll the browser page.";
  },
  async call({ direction, ref }: z.infer<ScrollSchema>) {
    try {
      if (ref) {
        const rect = await refRect(ref);
        if (!rect) return stale(ref);
        return ok(`Scrolled ${ref} into view.`);
      }
      const dir = direction ?? "down";
      if (dir === "top" || dir === "bottom") {
        await pageEvaluate(
          `(() => { scrollTo({top: ${dir === "top" ? 0 : "document.body.scrollHeight"}, behavior: 'instant'}); return 'OK'; })()`,
        );
        return ok(`Scrolled to the ${dir}.`);
      }
      const vh = Number(await pageEvaluate("String(innerHeight)")) || 800;
      await pageScrollWheel(Math.round(vh * 0.85) * (dir === "down" ? 1 : -1));
      return ok(`Scrolled ${dir}.`);
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

const shotSchema = lazySchema(() =>
  z.strictObject({
    ref: z
      .string()
      .optional()
      .describe("Capture just this element (from BrowserReadPage)."),
  }),
);
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
      "Capture the page as a PNG. You SEE the image in the result (when your",
      "model takes images), and it is saved to the chat for the user.",
      "",
      "Use it for anything visual — layout, spacing, colour, whether a thing",
      "renders at all. For text and structure, BrowserReadPage is cheaper and",
      "more precise.",
    ].join("\n");
  },
  async description() {
    return "Screenshot the browser page (you see it; also saved for the user).";
  },
  async call({ ref }: z.infer<ShotSchema>, context: ToolUseContext) {
    const sessionId =
      (context as { sessionId?: string }).sessionId || "default";
    try {
      let region: { x: number; y: number; width: number; height: number } | undefined;
      if (ref) {
        const rect = await refRect(ref);
        if (!rect) return stale(ref);
        // Viewport-relative, which is what the transport takes — refRect has
        // just scrolled the element into view, so it is on screen.
        const pad = 16;
        region = {
          x: Math.max(0, rect.x - pad),
          y: Math.max(0, rect.y - pad),
          width: rect.w + pad * 2,
          height: rect.h + pad * 2,
        };
      }
      const bytes = await pageScreenshot(region);
      const name = `browser-${Date.now()}.png`;
      const path = saveArtifactBuffer(sessionId, name, bytes);
      const info = await pageInfo();
      const seesImages = activeModelAccepts("image");
      return {
        data: {
          text:
            `[artifact] image/png ${name} :: ${artifactReference(path)}\n` +
            `Markdown: ![${name}](${artifactReference(path)})\n` +
            `Screenshot of "${info.title}"${
              seesImages
                ? " — attached below."
                : " — saved for the user; your model does not take images, so use BrowserReadPage to inspect the page."
            }`,
          isError: false,
          ...(seesImages
            ? {
                imageBase64: bytes.toString("base64"),
                imageMediaType: "image/png",
              }
            : {}),
        },
      };
    } catch (err) {
      return fail(err, "Screenshot");
    }
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});

// ─── BrowserLogs ──────────────────────────────────────────────────────────

const logsSchema = lazySchema(() =>
  z.strictObject({
    kind: z
      .enum(["console", "network"])
      .describe("console = JS messages and errors; network = requests."),
    grep: z
      .string()
      .optional()
      .describe("Case-insensitive regex; only matching lines come back."),
    level: z
      .enum(["error", "warn"])
      .optional()
      .describe("Keep only errors (or warnings and worse)."),
    limit: z
      .number()
      .optional()
      .describe("How many lines, newest last. Default 100."),
  }),
);
type LogsSchema = ReturnType<typeof logsSchema>;

export const BrowserLogsTool = buildTool({
  name: "BrowserLogs",
  searchHint: "read the browser console or network log",
  maxResultSizeChars: 30_000,
  get inputSchema(): LogsSchema {
    return logsSchema();
  },
  userFacingName() {
    return "BrowserLogs";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  async prompt() {
    return [
      "Read what the page logged. Recording starts when the page opens, so the",
      "history is already there — including anything from before you asked.",
      "",
      "Start with level=error. Add grep to follow one thing. The result says how",
      "many lines exist in total, so you can tell a quiet page from a filtered",
      "one. The log is a real file; its path is in the result if you would",
      "rather use Grep or Read on it.",
    ].join("\n");
  },
  async description() {
    return "Read the browser's console or network log (filterable).";
  },
  async call({ kind, grep, level, limit }: z.infer<LogsSchema>) {
    try {
      const targetId = await pageTargetId();
      const res = readLog(targetId, kind, { grep, level, limit });
      if (res.lines.length === 0) {
        return ok(
          res.total === 0
            ? `Nothing in the ${kind} log yet. The page may not have run (or failed) anything.`
            : `No ${kind} lines matched (${res.total} recorded). Try without grep/level.`,
        );
      }
      const shown =
        res.matched > res.lines.length
          ? `showing the last ${res.lines.length} of ${res.matched} matches, ${res.total} lines recorded`
          : `${res.matched} of ${res.total} lines`;
      return ok(
        [`${kind} log — ${shown}`, `file: ${res.path}`, "", ...res.lines].join("\n"),
      );
    } catch (err) {
      return fail(err, "Reading the log");
    }
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});

// ─── BrowserEval ──────────────────────────────────────────────────────────

const evalSchema = lazySchema(() =>
  z.strictObject({
    javascript: z
      .string()
      .describe("Expression evaluated in the page. The last value is returned."),
  }),
);
type EvalSchema = ReturnType<typeof evalSchema>;

export const BrowserEvalTool = buildTool({
  name: "BrowserEval",
  searchHint: "run JavaScript in the browser page",
  maxResultSizeChars: 20_000,
  get inputSchema(): EvalSchema {
    return evalSchema();
  },
  userFacingName() {
    return "BrowserEval";
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
      "Evaluate an expression in the page and get its value back. For what the",
      "other tools cannot reach: computed styles, app state, a querySelectorAll",
      "count, localStorage.",
      "",
      "Prefer the other tools when they fit — a ref click behaves like a user,",
      "and el.click() from here does not. Async expressions are awaited.",
    ].join("\n");
  },
  async description() {
    return "Evaluate JavaScript in the page and return the result.";
  },
  async call({ javascript }: z.infer<EvalSchema>) {
    try {
      const value = await pageEvaluate(javascript);
      return ok(value === "" ? "(empty string)" : value);
    } catch (err) {
      return fail(err, "Evaluation");
    }
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});

// ─── BrowserResize ────────────────────────────────────────────────────────

const PRESETS: Record<string, { width: number; height: number; mobile: boolean }> = {
  mobile: { width: 390, height: 844, mobile: true },
  tablet: { width: 834, height: 1112, mobile: true },
  desktop: { width: 1440, height: 900, mobile: false },
};

const resizeSchema = lazySchema(() =>
  z.strictObject({
    preset: z
      .enum(["mobile", "tablet", "desktop", "reset"])
      .optional()
      .describe("mobile 390×844, tablet 834×1112, desktop 1440×900, or reset."),
    width: z.number().optional().describe("Custom viewport width in CSS pixels."),
    height: z.number().optional().describe("Custom viewport height in CSS pixels."),
  }),
);
type ResizeSchema = ReturnType<typeof resizeSchema>;

export const BrowserResizeTool = buildTool({
  name: "BrowserResize",
  searchHint: "change the browser viewport size",
  maxResultSizeChars: 2_000,
  get inputSchema(): ResizeSchema {
    return resizeSchema();
  },
  userFacingName() {
    return "BrowserResize";
  },
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      "Emulate a viewport size, for checking responsive layouts. The panel does",
      "not change size — the PAGE is told it is that wide, which is what media",
      "queries read.",
      "",
      "Always reset when you are done, or every later screenshot is at the size",
      "you left behind.",
    ].join("\n");
  },
  async description() {
    return "Emulate a viewport size (responsive checks).";
  },
  async call({ preset, width, height }: z.infer<ResizeSchema>) {
    try {
      if (preset === "reset") {
        await pageSetViewport(null);
        return ok("Viewport back to the panel's own size.");
      }
      const size =
        width && height
          ? { width, height, mobile: width < 600 }
          : PRESETS[preset ?? "desktop"]!;
      await pageSetViewport(size);
      return ok(
        `Viewport is now ${size.width}×${size.height}${size.mobile ? " (mobile)" : ""}. Reset it when you are done.`,
      );
    } catch (err) {
      return fail(err, "Resize");
    }
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});

// ─── BrowserTabs ──────────────────────────────────────────────────────────

const tabsSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(["list", "select", "close", "closeAll"])
      .describe(
        "What to do. Use BrowserNavigate to open a page. closeAll ends the whole session (its tab group), and only applies when driving the user's own browser.",
      ),
    tabId: z
      .string()
      .optional()
      .describe("Which tab (from action=list). Required for select/close."),
  }),
);
type TabsSchema = ReturnType<typeof tabsSchema>;

export const BrowserTabsTool = buildTool({
  name: "BrowserTabs",
  searchHint: "list, switch or close browser tabs",
  maxResultSizeChars: 6_000,
  get inputSchema(): TabsSchema {
    return tabsSchema();
  },
  userFacingName() {
    return "BrowserTabs";
  },
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      "See which pages are open and pick the one the other tools act on.",
      "",
      "Worth a look before assuming: the user may already have the page open,",
      "and switching to it keeps their scroll position and login.",
    ].join("\n");
  },
  async description() {
    return "List browser tabs, or switch/close one.";
  },
  async call({ action, tabId }: z.infer<TabsSchema>) {
    const engine = getBrowserConfig().engine;
    if (engine === "external")
      return {
        data: {
          text: "Tabs are only managed for the Browser panel. The external Chrome drives one page; use BrowserNavigate.",
          isError: true,
        },
      };
    // The bridge keeps its tabs in the user's own browser, grouped per
    // session, so the list comes from the extension rather than our registry.
    if (engine === "bridge") {
      const {
        bridgeCloseSession,
        bridgeCloseTab,
        bridgeListTabs,
        bridgeSelectTab,
        bridgeSession,
      } = await import("../browser/bridge.js");
      try {
        if (action === "list") {
          const tabs = await bridgeListTabs();
          if (tabs.length === 0)
            return ok(
              "No tabs open in this session. BrowserNavigate opens one, in a tab group named " +
                `"agent:${bridgeSession()}" beside the user's own tabs.`,
            );
          return ok(
            tabs
              .map(
                (t) =>
                  `${t.active ? "*" : " "} ${t.id}  ${t.title || "(untitled)"} — ${t.url}`,
              )
              .join("\n") + "\n\n* = the tab the other tools act on.",
          );
        }
        if (action === "closeAll") {
          const n = await bridgeCloseSession();
          return ok(`Closed ${n} tab(s) — the whole session's group is gone.`);
        }
        const id = Number(tabId);
        if (!tabId || Number.isNaN(id))
          return {
            data: {
              text: `action=${action} needs a numeric tabId (see action=list).`,
              isError: true,
            },
          };
        if (action === "select") {
          await bridgeSelectTab(id);
          return ok(`Now acting on tab ${id}.`);
        }
        await bridgeCloseTab(id);
        return ok(`Closed tab ${id}.`);
      } catch (err) {
        return fail(err, "Tabs");
      }
    }
    if (action === "closeAll")
      return {
        data: {
          text: "closeAll only applies when driving the user's own browser (the bridge engine), where tabs live in a session's tab group. Close tabs one at a time here.",
          isError: true,
        },
      };
    try {
      if (action === "list") {
        const tabs = listTabs();
        if (tabs.length === 0)
          return ok("No tabs open. BrowserNavigate opens one.");
        return ok(
          tabs
            .map(
              (t) =>
                `${t.active ? "*" : " "} ${t.id}  ${t.title || "(untitled)"} — ${t.url}`,
            )
            .join("\n") + "\n\n* = the tab the other tools act on.",
        );
      }
      if (!tabId)
        return { data: { text: `action=${action} needs tabId (see action=list).`, isError: true } };
      const wc = tabContents(tabId);
      if (!wc)
        return {
          data: { text: `No tab ${tabId}. Call action=list for current ids.`, isError: true },
        };
      if (action === "select") {
        setActiveTab(tabId);
        return ok(`Now acting on ${tabId} — ${wc.getURL()}`);
      }
      wc.close();
      return ok(`Closed ${tabId}.`);
    } catch (err) {
      return fail(err, "Tabs");
    }
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});

/** Where this page's logs live — used by the system-prompt hint. */
export { logPath };
