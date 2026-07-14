/**
 * Minimal Chrome DevTools Protocol client (flat session mode) — just enough
 * for Browser Use: attach to a page, navigate, evaluate, screenshot, keys.
 */

import WebSocket from "ws";
import { ensureBrowser } from "./chrome.js";

interface CdpResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

const CMD_TIMEOUT_MS = 20_000;

class CdpConnection {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  private eventWaiters: {
    method: string;
    sessionId?: string;
    resolve: () => void;
  }[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      let msg: CdpResponse;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result ?? {});
        return;
      }
      if (msg.method) {
        this.eventWaiters = this.eventWaiters.filter((w) => {
          if (
            w.method === msg.method &&
            (!w.sessionId || w.sessionId === msg.sessionId)
          ) {
            w.resolve();
            return false;
          }
          return true;
        });
      }
    });
    ws.on("close", () => {
      for (const [, p] of this.pending)
        p.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, CMD_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      );
    });
  }

  /** Resolve when an event fires (or after timeoutMs — navigation is racy). */
  waitEvent(method: string, sessionId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter((w) => w.resolve !== done);
        resolve();
      }, timeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.eventWaiters.push({ method, sessionId, resolve: done });
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* closed */
    }
  }
}

let conn: CdpConnection | null = null;
let pageSession: string | null = null;

async function connect(): Promise<CdpConnection> {
  if (conn?.open) return conn;
  const url = await ensureBrowser();
  const ws = new WebSocket(url, { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (e) => reject(e));
  });
  conn = new CdpConnection(ws);
  pageSession = null;
  return conn;
}

/** Attach to the first real page tab (create one if none). */
async function ensurePage(): Promise<{ c: CdpConnection; sid: string }> {
  const c = await connect();
  if (pageSession) {
    // Validate the session is still alive with a cheap call.
    try {
      await c.send("Runtime.evaluate", { expression: "1" }, pageSession);
      return { c, sid: pageSession };
    } catch {
      pageSession = null;
    }
  }
  const targets = (await c.send("Target.getTargets")) as {
    targetInfos?: { targetId: string; type: string; url: string }[];
  };
  let target = targets.targetInfos?.find(
    (t) => t.type === "page" && !t.url.startsWith("devtools"),
  );
  if (!target) {
    const created = (await c.send("Target.createTarget", {
      url: "about:blank",
    })) as { targetId?: string };
    target = { targetId: created.targetId ?? "", type: "page", url: "" };
  }
  const attached = (await c.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  })) as { sessionId?: string };
  if (!attached.sessionId) throw new Error("Failed to attach to the page");
  pageSession = attached.sessionId;
  await c.send("Page.enable", {}, pageSession);
  await c.send("Runtime.enable", {}, pageSession);
  return { c, sid: pageSession };
}

// ─── High-level page operations (what the tools call) ────────────────────

export async function pageNavigate(
  url: string,
): Promise<{ title: string; url: string }> {
  const { c, sid } = await ensurePage();
  const wait = c.waitEvent("Page.loadEventFired", sid, 12_000);
  await c.send("Page.navigate", { url }, sid);
  await wait;
  return pageInfo();
}

export async function pageInfo(): Promise<{ title: string; url: string }> {
  const { c, sid } = await ensurePage();
  const r = (await c.send(
    "Runtime.evaluate",
    {
      expression: "JSON.stringify({t: document.title, u: location.href})",
      returnByValue: true,
    },
    sid,
  )) as { result?: { value?: string } };
  const parsed = JSON.parse(r.result?.value ?? "{}") as { t?: string; u?: string };
  return { title: parsed.t ?? "", url: parsed.u ?? "" };
}

export async function pageEvaluate(expression: string): Promise<string> {
  const { c, sid } = await ensurePage();
  const r = (await c.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sid,
  )) as {
    result?: { value?: unknown; description?: string };
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

export async function pageScreenshot(): Promise<Uint8Array> {
  const { c, sid } = await ensurePage();
  const r = (await c.send(
    "Page.captureScreenshot",
    { format: "png" },
    sid,
  )) as { data?: string };
  if (!r.data) throw new Error("Screenshot failed");
  return Buffer.from(r.data, "base64");
}

// ─── Human-like trusted input ─────────────────────────────────────────────
// Anti-bot systems flag pages that receive clicks with no pointer trail,
// instant value fills, and zero inter-event latency. These helpers drive the
// page through CDP Input.dispatch* (trusted events) with human pacing: the
// mouse travels a slightly curved, eased path; typing is per-key with jitter;
// scrolling arrives as several wheel ticks.

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

async function viewport(): Promise<{ w: number; h: number }> {
  try {
    const v = await pageEvaluate(
      "JSON.stringify({w: innerWidth, h: innerHeight})",
    );
    const p = JSON.parse(v) as { w?: number; h?: number };
    return { w: p.w || 1280, h: p.h || 800 };
  } catch {
    return { w: 1280, h: 800 };
  }
}

/** Move the mouse to (x, y) along a curved, eased path with jitter. */
export async function pageMoveMouse(x: number, y: number): Promise<void> {
  const { c, sid } = await ensurePage();
  if (!mouseSeeded) {
    const { w, h } = await viewport();
    mouseX = rand(w * 0.2, w * 0.8);
    mouseY = rand(h * 0.2, h * 0.8);
    mouseSeeded = true;
  }
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
    const t = t0 < 0.5 ? 2 * t0 * t0 : 1 - Math.pow(-2 * t0 + 2, 2) / 2;
    const px =
      (1 - t) * (1 - t) * startX + 2 * (1 - t) * t * cx + t * t * x +
      (i < steps ? rand(-1.5, 1.5) : 0);
    const py =
      (1 - t) * (1 - t) * startY + 2 * (1 - t) * t * cy + t * t * y +
      (i < steps ? rand(-1.5, 1.5) : 0);
    await c.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: px, y: py, button: "none" },
      sid,
    );
    await humanPause(8, 26);
  }
  mouseX = x;
  mouseY = y;
}

/** Human click: travel to the point, hover briefly, press, release. */
export async function pageClickAt(x: number, y: number): Promise<void> {
  const { c, sid } = await ensurePage();
  await pageMoveMouse(x, y);
  await humanPause(70, 220);
  const base = { x, y, button: "left", clickCount: 1 };
  await c.send(
    "Input.dispatchMouseEvent",
    { ...base, type: "mousePressed", buttons: 1 },
    sid,
  );
  await humanPause(45, 130);
  await c.send(
    "Input.dispatchMouseEvent",
    { ...base, type: "mouseReleased", buttons: 0 },
    sid,
  );
}

/** Type text with real per-key events and human inter-key latency. */
export async function pageTypeText(text: string): Promise<void> {
  const { c, sid } = await ensurePage();
  for (const ch of text) {
    const upper = ch.toUpperCase().charCodeAt(0);
    const isAlnum = /[a-z0-9]/i.test(ch);
    const vk = isAlnum ? { windowsVirtualKeyCode: upper, nativeVirtualKeyCode: upper } : {};
    if (ch === "\n") {
      await pagePressEnter();
    } else {
      await c.send(
        "Input.dispatchKeyEvent",
        { type: "keyDown", text: ch, key: ch, ...vk },
        sid,
      );
      await c.send(
        "Input.dispatchKeyEvent",
        { type: "keyUp", key: ch, ...vk },
        sid,
      );
    }
    // Humans type unevenly; word boundaries get a slightly longer beat.
    await humanPause(30, 110);
    if (ch === " " || ch === "." || ch === ",") await humanPause(20, 90);
  }
}

/** Scroll with several wheel ticks (positive deltaY scrolls down). */
export async function pageScrollWheel(totalDeltaY: number): Promise<void> {
  const { c, sid } = await ensurePage();
  if (!mouseSeeded) {
    const { w, h } = await viewport();
    mouseX = rand(w * 0.3, w * 0.7);
    mouseY = rand(h * 0.3, h * 0.7);
    mouseSeeded = true;
  }
  const chunks = Math.max(3, Math.min(6, Math.round(Math.abs(totalDeltaY) / 250)));
  let remaining = totalDeltaY;
  for (let i = 0; i < chunks; i++) {
    const part =
      i === chunks - 1 ? remaining : Math.round((totalDeltaY / chunks) * rand(0.75, 1.25));
    remaining -= part;
    await c.send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseWheel",
        x: mouseX,
        y: mouseY,
        deltaX: 0,
        deltaY: part,
        button: "none",
      },
      sid,
    );
    await humanPause(40, 120);
  }
}

export async function pagePressEnter(): Promise<void> {
  const { c, sid } = await ensurePage();
  const base = {
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    key: "Enter",
    code: "Enter",
  };
  await c.send(
    "Input.dispatchKeyEvent",
    { ...base, type: "rawKeyDown" },
    sid,
  );
  await c.send(
    "Input.dispatchKeyEvent",
    { ...base, type: "char", text: "\r" },
    sid,
  );
  await c.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" }, sid);
}

export function disconnectCdp(): void {
  conn?.close();
  conn = null;
  pageSession = null;
}
