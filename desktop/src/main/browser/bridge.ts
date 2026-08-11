/**
 * The bridge engine: the user's OWN browser, driven through an extension.
 *
 * The third answer to "which browser do the tools drive", and the only one
 * that starts logged in. Embedded is our <webview>; external is a fresh Chrome
 * with a profile of its own — both begin as strangers to every site, which is
 * why a Google sign-in in either is a fight (and, in the embedded case, one
 * Google deliberately refuses: an app that can script its own guest is exactly
 * what their anti-phishing check is for). The user's daily browser already
 * holds those sessions. Nothing has to be signed into twice.
 *
 * Shape, and it is the same one Kimi's WebBridge uses because there is only
 * one that works: a local service here, a small MV3 extension there, CDP in
 * between. The extension holds `chrome.debugger` on a tab and relays commands
 * both ways, so `send()` carries the very CDP messages the other two engines
 * send — which is why every input method, the human-paced mouse path and the
 * per-key typing above this file, works here with nothing added.
 *
 * WHERE WE GO FURTHER, stated only as far as it was measured: their shipped
 * background.js carries no credential of its own. It connects to a URL kept in
 * chrome.storage, defaulting to ws://127.0.0.1:10086/ws, and a popup action
 * (GENERATE_CONNECTION) POSTs /api/connections to obtain one — so a secret may
 * well live inside that URL; their service side is not in the zip and cannot
 * be read from here.
 *
 * What is certain is the shape of the risk, and it is why ours does both: a
 * WebSocket from a web page is not subject to CORS, so a bridge on a known
 * loopback port that answers whoever connects would hand a signed-in browser
 * to any site the user visits. So this one refuses every origin that is not an
 * extension, AND requires a pairing token the user carries across by hand.
 */

import { randomBytes } from "crypto";
import { cpSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { app } from "electron";
import { WebSocketServer, type WebSocket } from "ws";
import { getDataDir } from "../data-dir.js";
import type { BrowserTransport, CdpEventHandler, Rect } from "./transport.js";

/**
 * Loopback only, and a port unlikely to collide with a dev server.
 *
 * A FUNCTION, not a const: overridable because a second Code Monet — or the
 * probe, while the app is running — would otherwise fail to bind and look like
 * the bridge is broken. Read at call time because a bundled probe has its
 * imports hoisted above its own first statement, so a const would be fixed at
 * 8317 before the override could be set. The extension talks to 8317, so an
 * override means pairing that instance by hand; it is for testing.
 */
export function bridgePort(): number {
  return Number(process.env.MONET_BRIDGE_PORT) || 8317;
}
const CMD_TIMEOUT_MS = 20_000;

// ─── Pairing ────────────────────────────────────────────────────────────
//
// The token is the whole access control. It is generated here, shown in
// Settings, and typed into the extension once; the extension stores it and
// sends it as its first message. Anything that cannot produce it is closed.

interface BridgeFile {
  token: string;
}

function tokenPath(): string {
  return join(getDataDir(), "browser-bridge.json");
}

let cached: string | null = null;

/** The pairing token, minted on first use. */
export function bridgeToken(): string {
  if (cached) return cached;
  const path = tokenPath();
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<BridgeFile>;
      if (typeof raw.token === "string" && raw.token.length >= 16) {
        cached = raw.token;
        return cached;
      }
    }
  } catch {
    /* unreadable or corrupt — mint a new one below */
  }
  // Base32-ish and grouped, because a human retypes this.
  const token = randomBytes(15)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 20)
    .toUpperCase();
  cached = token;
  try {
    writeFileSync(path, JSON.stringify({ token } satisfies BridgeFile, null, 2));
  } catch (err) {
    console.error("[bridge] could not save the pairing token:", err);
  }
  return token;
}

/** Forget the current token and mint another — "unpair every browser". */
export function regenerateBridgeToken(): string {
  cached = null;
  try {
    writeFileSync(tokenPath(), JSON.stringify({ token: "" }));
  } catch {
    /* the mint below rewrites it anyway */
  }
  cached = null;
  const next = bridgeToken();
  // Anything paired with the old token is no longer trusted.
  if (client) {
    try {
      client.close(4001, "unpaired");
    } catch {
      /* already gone */
    }
    client = null;
  }
  return next;
}

// ─── Getting the extension into the browser ─────────────────────────────

/** The extension as shipped with the app. */
function extensionSource(): string {
  // Packaged: resources/browser-extension (electron-builder extraResources).
  // Dev: the repo folder next to src/.
  const packaged = join(process.resourcesPath ?? "", "browser-extension");
  if (existsSync(packaged)) return packaged;
  return join(app.getAppPath(), "resources", "browser-extension");
}

/**
 * Put a copy of the extension where the user can load it, and answer with the
 * path.
 *
 * A FOLDER, not a zip, and that is the point: Chrome's "Load unpacked" wants a
 * directory, so shipping a zip (as Kimi does) only adds a step where the user
 * has to find it and unpack it first. Copied out of the app rather than loaded
 * in place because the app directory can be read-only or inside an asar, and
 * because a path under Downloads is one the user can actually navigate to in
 * Chrome's file picker.
 */
export function exportBridgeExtension(): { ok: boolean; path?: string; error?: string } {
  try {
    const src = extensionSource();
    if (!existsSync(src))
      return { ok: false, error: "The extension files are missing from this build." };
    const dest = join(app.getPath("downloads"), "code-monet-bridge-extension");
    cpSync(src, dest, { recursive: true });
    return { ok: true, path: dest };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── The local service ──────────────────────────────────────────────────

interface Pending {
  resolve: (r: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

let server: WebSocketServer | null = null;
let client: WebSocket | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
const handlers = new Set<CdpEventHandler>();

/** One of the agent's tabs, as the extension last described it. */
export interface BridgeTab {
  id: number;
  url: string;
  title: string;
  session: string | null;
  active: boolean;
}
/** Every tab the agent holds, across sessions. Pushed by the extension after
 * anything that changes them, so no round trip is needed to list them. */
let agentTabs: BridgeTab[] = [];

export interface BridgeStatus {
  listening: boolean;
  port: number;
  connected: boolean;
  tabs: BridgeTab[];
}

export function bridgeStatus(): BridgeStatus {
  return {
    listening: server !== null,
    port: bridgePort(),
    connected: client !== null && client.readyState === 1,
    tabs: agentTabs,
  };
}

/**
 * Which session's tabs a run works in.
 *
 * This is the name on the tab group in the user's browser — `agent:<session>`
 * — so it wants to be recognisable rather than a uuid. Kimi's screenshots show
 * `agent:x-news`, `agent:gforms`; same idea.
 */
let sessionName = "agent";
export function setBridgeSession(name: string): void {
  sessionName = (name || "agent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24) || "agent";
}
export function bridgeSession(): string {
  return sessionName;
}

/** A message the extension sends us. */
interface FromExtension {
  type?: string;
  id?: number;
  ok?: boolean;
  result?: Record<string, unknown>;
  error?: string;
  method?: string;
  params?: Record<string, unknown>;
  token?: string;
  tabs?: BridgeTab[];
}

/**
 * Start listening for the extension. Idempotent.
 *
 * Bound to 127.0.0.1 explicitly: a bridge that answers on the LAN would hand
 * the user's logged-in browser to the network.
 */
export function startBridge(): void {
  if (server) return;
  const wss = new WebSocketServer({ host: "127.0.0.1", port: bridgePort() });
  server = wss;

  wss.on("connection", (ws, req) => {
    // Only an extension may speak here. A page's WebSocket carries its own
    // https origin; an extension's carries chrome-extension://<id>.
    const origin = String(req.headers.origin ?? "");
    if (!/^chrome-extension:\/\//i.test(origin)) {
      console.warn(`[bridge] refused a connection from origin ${origin || "(none)"}`);
      ws.close(4003, "extension origins only");
      return;
    }

    let greeted = false;
    const greetingDeadline = setTimeout(() => {
      if (!greeted) ws.close(4008, "no pairing token");
    }, 5_000);

    ws.on("message", (data) => {
      let msg: FromExtension;
      try {
        msg = JSON.parse(String(data)) as FromExtension;
      } catch {
        return;
      }

      // The handshake, before anything else is honoured.
      if (!greeted) {
        if (msg.type !== "hello" || msg.token !== bridgeToken()) {
          console.warn("[bridge] refused a connection with a bad pairing token");
          ws.close(4001, "bad pairing token");
          return;
        }
        greeted = true;
        clearTimeout(greetingDeadline);
        // One browser at a time: a second one would race for the same tab.
        if (client && client !== ws) {
          try {
            client.close(4009, "replaced by a newer connection");
          } catch {
            /* already gone */
          }
        }
        client = ws;
        ws.send(JSON.stringify({ type: "welcome" }));
        console.log("[bridge] a browser extension paired");
        return;
      }

      if (msg.type === "tabs" && Array.isArray(msg.tabs)) {
        agentTabs = msg.tabs;
        return;
      }
      if (msg.type === "event" && msg.method) {
        for (const h of handlers) h(msg.method, msg.params ?? {});
        return;
      }
      if (msg.id != null) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok === false) p.reject(new Error(msg.error || "bridge call failed"));
        else p.resolve(msg.result ?? {});
      }
    });

    ws.on("close", () => {
      clearTimeout(greetingDeadline);
      if (client === ws) {
        client = null;
        agentTabs = [];
        for (const [, p] of pending) {
          clearTimeout(p.timer);
          p.reject(new Error("the browser extension disconnected"));
        }
        pending.clear();
      }
    });
  });

  // Failing to BIND and erroring while bound are different, and treating them
  // the same is how one refused connection turned into EADDRINUSE: the handle
  // was cleared on any error, so the next startBridge() — which is idempotent
  // only while `server` is set — tried to listen a second time on a port the
  // first server still held. Found by the probe, not by reading.
  let bound = false;
  wss.on("listening", () => {
    bound = true;
    console.log(`[bridge] listening on 127.0.0.1:${bridgePort()}`);
  });
  wss.on("error", (err) => {
    console.error(`[bridge] ${bound ? "server error" : "listen failed"}:`, err);
    if (!bound) server = null;
  });
}

export function stopBridge(): void {
  try {
    client?.close(1001, "shutting down");
  } catch {
    /* already gone */
  }
  client = null;
  agentTabs = [];
  server?.close();
  server = null;
}

/** Why the extension is not usable right now, said the way the user can act on. */
class NoBridgeError extends Error {
  constructor() {
    super(
      "No browser is paired. Install the Code Monet bridge extension in your " +
        "browser and enter the pairing code from Settings → Automation, then " +
        "click the extension on the tab you want the agent to use.",
    );
    this.name = "NoBridgeError";
  }
}

function call(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ws = client;
  if (!ws || ws.readyState !== 1) return Promise.reject(new NoBridgeError());
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`the browser did not answer ${String(payload.method ?? payload.op)} in 20s`));
    }, CMD_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ id, ...payload }));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ─── The transport ──────────────────────────────────────────────────────

class BridgeTransport implements BrowserTransport {
  readonly kind = "bridge" as const;
  readonly targetId = "bridge";

  /** Every CDP command goes out as-is; the extension replays it through
   * chrome.debugger on this session's current tab. This is the whole reason
   * the input methods, the refs and the tools need no bridge-specific code. */
  async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return call({ type: "cdp", method, params, session: sessionName });
  }

  async waitEvent(method: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve();
      }, timeoutMs);
      const off = this.onEvent((m) => {
        if (m === method) {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
  }

  onEvent(handler: CdpEventHandler): () => void {
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  // Navigation goes through chrome.tabs rather than CDP Page.navigate: these
  // are real tabs in the user's browser, and the tabs API keeps their history,
  // their group and their back button behaving the way the user expects.
  // Opens one when the session has none — the agent should not have to know
  // whether it has been here before.
  async navigate(url: string): Promise<void> {
    await call({ type: "tabs", op: "navigate", url, session: sessionName });
  }

  async reload(): Promise<void> {
    await call({ type: "tabs", op: "reload", session: sessionName });
  }

  async goHistory(delta: -1 | 1): Promise<void> {
    await call({
      type: "tabs",
      op: delta < 0 ? "back" : "forward",
      session: sessionName,
    });
  }

  /** Bring the current tab to the front IN THE USER'S BROWSER — a capture of a
   * background tab never answers, exactly as in the embedded engine. */
  async reveal(): Promise<void> {
    await call({ type: "tabs", op: "activate", session: sessionName });
  }

  async mouseMove(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
    });
  }

  async mouseDown(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
  }

  async mouseUp(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }

  async wheel(x: number, y: number, deltaY: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      button: "none",
      buttons: 0,
      deltaX: 0,
      deltaY,
    });
  }

  async typeChar(ch: string): Promise<void> {
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      text: ch,
      unmodifiedText: ch,
      key: ch,
    });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
  }

  async pressKey(key: string): Promise<void> {
    const base = { key, windowsVirtualKeyCode: virtualKey(key) };
    await this.send("Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" });
    if (key === "Enter")
      await this.send("Input.dispatchKeyEvent", {
        ...base,
        type: "char",
        text: "\r",
      });
    await this.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }

  async screenshot(rect?: Rect): Promise<Buffer> {
    const params: Record<string, unknown> = { format: "png" };
    if (rect)
      params.clip = { ...rect, scale: 1 };
    const r = await this.send("Page.captureScreenshot", params);
    return Buffer.from(String(r.data ?? ""), "base64");
  }
}

/** The codes CDP wants for the named keys the tools use. */
function virtualKey(key: string): number {
  switch (key) {
    case "Enter":
      return 13;
    case "Tab":
      return 9;
    case "Backspace":
      return 8;
    case "Escape":
      return 27;
    case "ArrowUp":
      return 38;
    case "ArrowDown":
      return 40;
    case "ArrowLeft":
      return 37;
    case "ArrowRight":
      return 39;
    default:
      return 0;
  }
}

// ─── Tabs, for the BrowserTabs tool ─────────────────────────────────────
//
// The agent works in several at once — a search here, the form it is filling
// there — which is the whole point of it having its own group rather than one
// borrowed tab.

/** Open a NEW tab in this session's group. Returns its id. */
export async function bridgeOpenTab(url: string): Promise<number> {
  const r = await call({
    type: "tabs",
    op: "open",
    url,
    session: sessionName,
  });
  return Number(r.tabId);
}

/** The agent's tabs, freshest first asked. */
export async function bridgeListTabs(): Promise<BridgeTab[]> {
  await call({ type: "tabs", op: "list", session: sessionName });
  // The extension answers the list by pushing `tabs`, which the socket handler
  // above stores — so by the time the call resolves, this is current.
  return agentTabs;
}

/** Point the other tools at one of them. */
export async function bridgeSelectTab(tabId: number): Promise<void> {
  await call({ type: "tabs", op: "select", tabId, session: sessionName });
}

export async function bridgeCloseTab(tabId: number): Promise<void> {
  await call({ type: "tabs", op: "close", tabId, session: sessionName });
}

/** Close everything this session opened — one action ends the excursion. */
export async function bridgeCloseSession(): Promise<number> {
  const r = await call({ type: "tabs", op: "close_session", session: sessionName });
  return Number(r.closed ?? 0);
}

let transport: BridgeTransport | null = null;

export function getBridgeTransport(): BrowserTransport {
  startBridge();
  if (!client || client.readyState !== 1) throw new NoBridgeError();
  transport ??= new BridgeTransport();
  return transport;
}
