/**
 * Page operations, paced like a person.
 *
 * Anti-bot systems flag pages that receive clicks with no pointer trail,
 * instant value fills and zero inter-event latency. So the mouse travels a
 * slightly curved, eased path; typing is per-key with jitter; scrolling arrives
 * as several wheel ticks. None of that depends on which engine is driving,
 * which is why it lives above the transport and is written once.
 *
 * (This file was the CDP client. The client moved to external.ts when the
 * embedded panel arrived — what is left is the part that was never about CDP.)
 */

import {
  getTransport,
  NoPageError,
  resetEmbeddedTransports,
  type BrowserTransport,
  type Rect,
} from "./transport.js";
import { disconnectExternal } from "./external.js";
import { activeContents, ensureTab } from "./registry.js";

const rand = (min: number, max: number): number =>
  min + Math.random() * (max - min);
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
const humanPause = (min: number, max: number): Promise<void> =>
  sleep(Math.round(rand(min, max)));

// The virtual cursor persists between actions so every movement starts where
// the previous one ended (a teleporting cursor is itself a bot signal).
let mouseX = 0;
let mouseY = 0;
let mouseSeeded = false;

/**
 * The transport, opening a page first if the panel has none.
 *
 * Every tool goes through here, so "no page yet" is handled once rather than
 * being an error each tool has to explain.
 */
async function transport(openAt = "about:blank"): Promise<BrowserTransport> {
  try {
    return await getTransport();
  } catch (err) {
    if (!(err instanceof NoPageError)) throw err;
    await ensureTab(openAt);
    return getTransport();
  }
}

async function viewport(): Promise<{ w: number; h: number }> {
  try {
    const v = await pageEvaluate("JSON.stringify({w: innerWidth, h: innerHeight})");
    const p = JSON.parse(v) as { w?: number; h?: number };
    return { w: p.w || 1280, h: p.h || 800 };
  } catch {
    return { w: 1280, h: 800 };
  }
}

async function seedMouse(): Promise<void> {
  if (mouseSeeded) return;
  const { w, h } = await viewport();
  mouseX = rand(w * 0.2, w * 0.8);
  mouseY = rand(h * 0.2, h * 0.8);
  mouseSeeded = true;
}

// ─── Navigation and reading ───────────────────────────────────────────────

export async function pageNavigate(
  url: string,
  newTab = false,
): Promise<{ title: string; url: string }> {
  // A SECOND TAB, when asked for one. Without this the agent had no way to
  // open one at all: navigate always reused the current page, BrowserTabs
  // could only list/select/close, and window.open from BrowserEval is stopped
  // by the popup blocker (a scripted open is not a user gesture). So a job
  // that wants two sites side by side — compare these, watch that while
  // filling this — could only visit them one after another, losing the first.
  if (newTab) {
    const { getBrowserConfig } = await import("./config.js");
    const engine = getBrowserConfig().engine;
    if (engine === "external")
      throw new Error(
        "The external Chrome drives a single page — it has no second tab to open. Switch to the Browser panel or your own browser (Settings → Automation) for several pages at once.",
      );
    if (engine === "bridge") {
      // The extension waits for the tab to finish loading before answering,
      // so there is no load event left to wait for here.
      const { bridgeOpenTab } = await import("./bridge.js");
      await bridgeOpenTab(url);
    } else {
      const { openNewTab } = await import("./registry.js");
      await openNewTab(url);
      const t = await getTransport();
      await t.waitEvent("Page.loadEventFired", 12_000);
    }
    return pageInfo();
  }
  const hadPage = await hasPage();
  const t = await transport(url);
  // When the panel had no tab, ensureTab already opened one AT this url —
  // navigating again would load it twice.
  if (hadPage) {
    const wait = t.waitEvent("Page.loadEventFired", 12_000);
    await t.navigate(url);
    await wait;
  } else {
    await t.waitEvent("Page.loadEventFired", 12_000);
  }
  return pageInfo();
}

async function hasPage(): Promise<boolean> {
  try {
    await getTransport();
    return true;
  } catch {
    return false;
  }
}

export async function pageInfo(): Promise<{ title: string; url: string }> {
  const raw = await pageEvaluate(
    "JSON.stringify({t: document.title, u: location.href})",
  );
  const parsed = JSON.parse(raw) as { t?: string; u?: string };
  if (parsed.u) lastKnownUrl = parsed.u;
  return { title: parsed.t ?? "", url: parsed.u ?? "" };
}

/**
 * Where the page is, without a round trip.
 *
 * The permission check runs before every acting tool call, and asking the page
 * would mean a CDP evaluate each time — on the embedded engine the WebContents
 * already knows. The external engine has no such shortcut, so the last URL we
 * saw stands in; it is refreshed by every navigation and every pageInfo().
 */
let lastKnownUrl: string | null = null;

export function currentPageUrl(): string | null {
  const wc = activeContents();
  if (wc) {
    const url = wc.getURL();
    if (url) return url;
  }
  return lastKnownUrl;
}

export async function pageEvaluate(expression: string): Promise<string> {
  const t = await transport();
  const r = (await t.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description ??
        r.exceptionDetails.text ??
        "Evaluation failed",
    );
  }
  const v = r.result?.value;
  return typeof v === "string" ? v : JSON.stringify(v ?? null);
}

export async function pageScreenshot(clip?: Rect): Promise<Buffer> {
  const t = await transport();
  return t.screenshot(clip);
}

// ─── Human-like trusted input ─────────────────────────────────────────────

/** Move the mouse to (x, y) along a curved, eased path with jitter. */
export async function pageMoveMouse(x: number, y: number): Promise<void> {
  const t = await transport();
  await seedMouse();
  const dx = x - mouseX;
  const dy = y - mouseY;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(6, Math.min(22, Math.round(dist / 40)));
  // A control point off the straight line makes the path a shallow arc.
  const bend = Math.min(80, dist * 0.25) * (Math.random() < 0.5 ? -1 : 1);
  const cx = mouseX + dx * 0.5 - (dy / (dist || 1)) * bend;
  const cy = mouseY + dy * 0.5 + (dx / (dist || 1)) * bend;
  const startX = mouseX;
  const startY = mouseY;
  for (let i = 1; i <= steps; i++) {
    const t0 = i / steps;
    // Ease in-out: slow start, fast middle, slow arrival.
    const e = t0 < 0.5 ? 2 * t0 * t0 : 1 - Math.pow(-2 * t0 + 2, 2) / 2;
    const px =
      (1 - e) * (1 - e) * startX +
      2 * (1 - e) * e * cx +
      e * e * x +
      (i < steps ? rand(-1.5, 1.5) : 0);
    const py =
      (1 - e) * (1 - e) * startY +
      2 * (1 - e) * e * cy +
      e * e * y +
      (i < steps ? rand(-1.5, 1.5) : 0);
    await t.mouseMove(px, py);
    await humanPause(8, 26);
  }
  mouseX = x;
  mouseY = y;
}

/** Human click: travel to the point, hover briefly, press, release. */
export async function pageClickAt(x: number, y: number): Promise<void> {
  const t = await transport();
  await pageMoveMouse(x, y);
  await humanPause(70, 220);
  await t.mouseDown(x, y);
  await humanPause(45, 130);
  await t.mouseUp(x, y);
}

/** Type text with real per-key events and human inter-key latency. */
export async function pageTypeText(text: string): Promise<void> {
  const t = await transport();
  for (const ch of text) {
    if (ch === "\n") await t.pressKey("Enter");
    else await t.typeChar(ch);
    // Humans type unevenly; word boundaries get a slightly longer beat.
    await humanPause(30, 110);
    if (ch === " " || ch === "." || ch === ",") await humanPause(20, 90);
  }
}

/** Scroll with several wheel ticks (positive deltaY scrolls down). */
export async function pageScrollWheel(totalDeltaY: number): Promise<void> {
  const t = await transport();
  // Scrolling is visual, and a parked guest scrolls unreliably or not at all.
  await t.reveal();
  await seedMouse();
  // A wheel event with no pointer over the page scrolls nothing. Measured:
  // without this move the page stayed at scrollY 0.
  await t.mouseMove(mouseX, mouseY);
  const chunks = Math.max(3, Math.min(6, Math.round(Math.abs(totalDeltaY) / 250)));
  let remaining = totalDeltaY;
  for (let i = 0; i < chunks; i++) {
    const part =
      i === chunks - 1
        ? remaining
        : Math.round((totalDeltaY / chunks) * rand(0.75, 1.25));
    remaining -= part;
    await t.wheel(mouseX, mouseY, part);
    await humanPause(40, 120);
  }
}

/** Back, forward or reload — through whatever the engine's safe path is. */
export async function pageHistory(
  action: "back" | "forward" | "reload",
): Promise<void> {
  const t = await transport();
  if (action === "reload") await t.reload();
  else await t.goHistory(action === "back" ? -1 : 1);
}

export async function pagePressEnter(): Promise<void> {
  const t = await transport();
  await t.pressKey("Enter");
}

/**
 * Give the page a moment to react, then wait until it has finished loading.
 *
 * Built into the acting tools instead of exposed as BrowserWaitFor. A model
 * that has to decide when to wait gets it wrong in both directions — reading a
 * page mid-navigation and reporting the old one, or waiting after a click that
 * changed nothing. Neither is a decision worth delegating.
 */
export async function pageSettle(maxMs = 6_000): Promise<void> {
  await sleep(450);
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      if ((await pageEvaluate("document.readyState")) === "complete") return;
    } catch {
      // The execution context went away mid-navigation. The next evaluate
      // lands in the new document, so keep waiting rather than reporting.
    }
    await sleep(150);
  }
}

/** Emulate a viewport size (responsive checks), or clear the override. */
export async function pageSetViewport(
  size: { width: number; height: number; mobile?: boolean } | null,
): Promise<void> {
  const t = await transport();
  if (!size) {
    await t.send("Emulation.clearDeviceMetricsOverride");
    return;
  }
  await t.send("Emulation.setDeviceMetricsOverride", {
    width: size.width,
    height: size.height,
    deviceScaleFactor: 1,
    mobile: size.mobile ?? false,
  });
}

/** The transport's id, for naming this page's log files. */
export async function pageTargetId(): Promise<string> {
  return (await transport()).targetId;
}

/** Tear down both engines (feature turned off, engine switched, app quit). */
export function disconnectCdp(): void {
  disconnectExternal();
  resetEmbeddedTransports();
}
