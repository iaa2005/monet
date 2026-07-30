/**
 * One way to drive a page, two things that can be driven.
 *
 * The embedded engine is the panel's <webview>; the external one is a separate
 * Chrome. Everything above this file — refs, human-paced input, the tools
 * themselves — is written once and works on both, which is the only reason
 * keeping two engines is affordable.
 *
 * The interface is stated in INTENT (move the mouse there, type this character)
 * rather than in CDP messages, because the two engines disagree about input.
 * Embedded uses webContents.sendInputEvent: native, unambiguously trusted, and
 * it needs no debugger session to work. External has no such API and uses
 * CDP Input.dispatch*. Everything else really is CDP on both sides.
 */

import type { WebContents } from "electron";
import { getBrowserConfig, type BrowserEngine } from "./config.js";
import { activeContents } from "./registry.js";
import { getExternalTransport } from "./external.js";
import { ensureLogging, stopLogging } from "./logs.js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CdpEventHandler = (
  method: string,
  params: Record<string, unknown>,
) => void;

export interface BrowserTransport {
  readonly kind: BrowserEngine;
  /** Stable id for this page — names its log files. */
  readonly targetId: string;

  send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /** Resolve on the next matching CDP event, or when the timeout runs out. */
  waitEvent(method: string, timeoutMs: number): Promise<void>;
  /** Subscribe to every CDP event. Returns an unsubscribe. */
  onEvent(handler: CdpEventHandler): () => void;

  mouseMove(x: number, y: number): Promise<void>;
  mouseDown(x: number, y: number): Promise<void>;
  mouseUp(x: number, y: number): Promise<void>;
  /** deltaY uses the DOM's sign: positive scrolls DOWN. */
  wheel(x: number, y: number, deltaY: number): Promise<void>;
  /** One character, as a real key press. */
  typeChar(ch: string): Promise<void>;
  /** A named key: Enter, Tab, Backspace, Escape, ArrowDown… */
  pressKey(key: string): Promise<void>;

  screenshot(clip?: Rect): Promise<Buffer>;
}

// ─── Embedded: the panel's own <webview> ──────────────────────────────────

class EmbeddedTransport implements BrowserTransport {
  readonly kind = "embedded" as const;
  private handlers = new Set<CdpEventHandler>();
  private attached = false;

  constructor(private readonly wc: WebContents) {}

  get targetId(): string {
    return `wc-${this.wc.id}`;
  }

  /**
   * Attach the debugger once, and keep it.
   *
   * The domains are enabled here rather than per-call because Network and Log
   * only report what happened AFTER they were enabled — turning them on when
   * someone asks for the logs would return an empty file and look like a bug
   * in the page.
   */
  private async ensureAttached(): Promise<void> {
    if (this.attached && this.wc.debugger.isAttached()) return;
    if (!this.wc.debugger.isAttached()) {
      try {
        this.wc.debugger.attach("1.3");
      } catch (err) {
        // DevTools open on this guest owns the session. Say so plainly: the
        // fix is one click, and "Runtime.evaluate failed" would not suggest it.
        throw new Error(
          `Could not attach to the page — close its DevTools first (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
      this.wc.debugger.on("message", (_e, method, params) => {
        for (const h of this.handlers)
          h(method, (params ?? {}) as Record<string, unknown>);
      });
      this.wc.debugger.once("detach", () => {
        this.attached = false;
      });
    }
    for (const domain of ["Page", "Runtime", "Network", "Log", "DOM"]) {
      try {
        await this.wc.debugger.sendCommand(`${domain}.enable`);
      } catch {
        /* a domain the page's target doesn't support is not fatal */
      }
    }
    this.attached = true;
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    await this.ensureAttached();
    return (await this.wc.debugger.sendCommand(method, params)) as Record<
      string,
      unknown
    >;
  }

  async waitEvent(method: string, timeoutMs: number): Promise<void> {
    await this.ensureAttached();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve();
      }, timeoutMs);
      const off = this.onEvent((m) => {
        if (m !== method) return;
        clearTimeout(timer);
        off();
        resolve();
      });
    });
  }

  onEvent(handler: CdpEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async mouseMove(x: number, y: number): Promise<void> {
    this.wc.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
  }

  async mouseDown(x: number, y: number): Promise<void> {
    this.wc.sendInputEvent({
      type: "mouseDown",
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
    });
  }

  async mouseUp(x: number, y: number): Promise<void> {
    this.wc.sendInputEvent({
      type: "mouseUp",
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
    });
  }

  /**
   * The one input that does NOT go through sendInputEvent.
   *
   * Chromium's native wheel delta is inverted relative to the DOM's, so the
   * same number scrolls opposite ways through sendInputEvent and through CDP.
   * Scrolling is not the input that needs to look native — clicks and keys are
   * — so it takes the path with one unambiguous convention on both engines.
   */
  async wheel(x: number, y: number, deltaY: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY,
      button: "none",
    });
  }

  async typeChar(ch: string): Promise<void> {
    // keyDown/char/keyUp: the page needs all three. `char` alone fills the
    // field but fires no keydown, and libraries that listen for keydown
    // (search-as-you-type, shortcut handlers) never react.
    this.wc.sendInputEvent({ type: "keyDown", keyCode: ch });
    this.wc.sendInputEvent({ type: "char", keyCode: ch });
    this.wc.sendInputEvent({ type: "keyUp", keyCode: ch });
  }

  async pressKey(key: string): Promise<void> {
    this.wc.sendInputEvent({ type: "keyDown", keyCode: key });
    if (key === "Enter") this.wc.sendInputEvent({ type: "char", keyCode: key });
    this.wc.sendInputEvent({ type: "keyUp", keyCode: key });
  }

  detach(): void {
    this.handlers.clear();
    this.attached = false;
    try {
      if (!this.wc.isDestroyed() && this.wc.debugger.isAttached())
        this.wc.debugger.detach();
    } catch {
      /* already gone */
    }
  }

  async screenshot(clip?: Rect): Promise<Buffer> {
    // fromSurface:false renders from the page itself rather than the window's
    // compositor surface. The panel's inactive tabs are parked off-screen, and
    // a surface capture of those comes back blank.
    const params: Record<string, unknown> = {
      format: "png",
      fromSurface: false,
      captureBeyondViewport: false,
    };
    if (clip) params.clip = { ...clip, scale: 1 };
    const res = (await this.send("Page.captureScreenshot", params)) as {
      data?: string;
    };
    if (!res.data) throw new Error("Screenshot failed");
    return Buffer.from(res.data, "base64");
  }
}

/** One transport per guest, so the debugger is attached once and events flow. */
const embedded = new Map<number, EmbeddedTransport>();

function embeddedTransport(wc: WebContents): EmbeddedTransport {
  const cached = embedded.get(wc.id);
  if (cached) return cached;
  const made = new EmbeddedTransport(wc);
  embedded.set(wc.id, made);
  wc.once("destroyed", () => embedded.delete(wc.id));
  return made;
}

/** Thrown when the embedded engine has no page yet — callers open one. */
export class NoPageError extends Error {
  constructor() {
    super("The Browser panel has no open page.");
    this.name = "NoPageError";
  }
}

/**
 * The transport the tools act through, per the user's engine setting.
 *
 * Recording starts here rather than at the first BrowserLogs call: Network and
 * Log only report what happens after they are enabled, so a recorder started on
 * demand would hand back an empty file for a page that has been running for a
 * minute.
 */
export async function getTransport(): Promise<BrowserTransport> {
  const t =
    getBrowserConfig().engine === "external"
      ? getExternalTransport()
      : embeddedFromActiveTab();
  ensureLogging(t);
  return t;
}

function embeddedFromActiveTab(): BrowserTransport {
  const wc = activeContents();
  if (!wc) throw new NoPageError();
  return embeddedTransport(wc);
}

/**
 * Drop cached embedded transports (feature turned off, app quitting).
 *
 * Detaching matters: while our debugger holds a guest, the user cannot open
 * DevTools on it. Turning the tools off should give that back.
 */
export function resetEmbeddedTransports(): void {
  for (const t of embedded.values()) {
    stopLogging(t.targetId);
    t.detach();
  }
  embedded.clear();
}
