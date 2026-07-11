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
