/**
 * The external engine: a separate Chrome/Edge, spoken to over a CDP WebSocket.
 *
 * Kept alongside the embedded panel because the two fail differently. A site
 * that fingerprints Electron, an extension you need, a login that lives in a
 * real profile — those want a real browser. Everything the tools do is the same
 * either way; only this transport changes.
 */

import WebSocket from "ws";
import { ensureBrowser } from "./chrome.js";
import type { BrowserTransport, CdpEventHandler, Rect } from "./transport.js";

interface CdpMessage {
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
  private handlers = new Set<CdpEventHandler>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(String(data)) as CdpMessage;
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
      if (msg.method)
        for (const h of this.handlers) h(msg.method, msg.params ?? {});
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

  onEvent(handler: CdpEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
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

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
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
  for (const domain of ["Page", "Runtime", "Network", "Log"]) {
    try {
      await c.send(`${domain}.enable`, {}, pageSession);
    } catch {
      /* optional domain */
    }
  }
  return { c, sid: pageSession };
}

/** Virtual key codes for the named keys the tools press. */
const VK: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Backspace: 8,
  Escape: 27,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
};

class ExternalTransport implements BrowserTransport {
  readonly kind = "external" as const;
  readonly targetId = "external";

  private async page(): Promise<{ c: CdpConnection; sid: string }> {
    return ensurePage();
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const { c, sid } = await this.page();
    return c.send(method, params, sid);
  }

  async waitEvent(method: string, timeoutMs: number): Promise<void> {
    const { c } = await this.page();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve();
      }, timeoutMs);
      const off = c.onEvent((m) => {
        if (m !== method) return;
        clearTimeout(timer);
        off();
        resolve();
      });
    });
  }

  onEvent(handler: CdpEventHandler): () => void {
    // The connection may not exist yet; subscribe once it does, and let the
    // caller unsubscribe either way.
    let off: (() => void) | null = null;
    let cancelled = false;
    void this.page().then(({ c }) => {
      if (cancelled) return;
      off = c.onEvent(handler);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }

  async mouseMove(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
    });
  }

  async mouseDown(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
      buttons: 1,
    });
  }

  async mouseUp(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
      buttons: 0,
    });
  }

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
    const upper = ch.toUpperCase().charCodeAt(0);
    const alnum = /[a-z0-9]/i.test(ch);
    const vk = alnum
      ? { windowsVirtualKeyCode: upper, nativeVirtualKeyCode: upper }
      : {};
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      text: ch,
      key: ch,
      ...vk,
    });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, ...vk });
  }

  async pressKey(key: string): Promise<void> {
    const code = VK[key];
    const base = {
      key,
      code: key,
      ...(code
        ? { windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }
        : {}),
    };
    await this.send("Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" });
    if (key === "Enter")
      await this.send("Input.dispatchKeyEvent", {
        ...base,
        type: "char",
        text: "\r",
      });
    await this.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }

  async screenshot(clip?: Rect): Promise<Buffer> {
    const params: Record<string, unknown> = { format: "png" };
    if (clip) params.clip = { ...clip, scale: 1 };
    const res = (await this.send("Page.captureScreenshot", params)) as {
      data?: string;
    };
    if (!res.data) throw new Error("Screenshot failed");
    return Buffer.from(res.data, "base64");
  }
}

const external = new ExternalTransport();

export function getExternalTransport(): BrowserTransport {
  return external;
}

export function disconnectExternal(): void {
  conn?.close();
  conn = null;
  pageSession = null;
}
