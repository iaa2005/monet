/**
 * The bridge's front door: who may drive the user's browser.
 *
 * This is the security surface of the whole engine. A WebSocket on loopback is
 * NOT private: a page you visit can open one to 127.0.0.1 and CORS does not
 * stop it, so a bridge that answers whoever connects hands a signed-in browser
 * to any site. Kimi's shipped extension talks to a fixed port with no
 * authentication at all (measured: no token, no handshake, no origin check in
 * its background.js) — this exists so ours cannot drift into that.
 *
 * Drives the REAL server over a real socket.
 *
 *   npm run smoke:bridge
 */

import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import WebSocket from "ws";

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

const { setDataDir } = await import("../src/main/data-dir.js");
setDataDir(mkdtempSync(join(tmpdir(), "bridge-probe-")));

const { startBridge, stopBridge, bridgeToken, bridgeStatus, BRIDGE_PORT } =
  await import("../src/main/browser/bridge.js");

// The probe BINDS A PORT, so it must give it back however it ends. Without
// this a failed run left a listener behind and every later run died on
// EADDRINUSE — which reads as the bridge being broken rather than the probe
// leaking. (Learned the hard way, this session.)
for (const signal of ["exit", "uncaughtException", "unhandledRejection"] as const)
  process.on(signal, (err?: unknown) => {
    try {
      stopBridge();
    } catch {
      /* going down anyway */
    }
    if (signal !== "exit") {
      console.error(err);
      process.exit(1);
    }
  });

startBridge();
const TOKEN = bridgeToken();
const URL = `ws://127.0.0.1:${BRIDGE_PORT}`;
const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

check("the token is long enough to be worth typing once", TOKEN.length >= 16, TOKEN.length);

/** Open a socket and report how it ended: "welcome" or the close code. */
function tryConnect(
  origin: string,
  token: string | null,
): Promise<{ welcomed: boolean; code: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL, { origin });
    let welcomed = false;
    const done = (code: number): void => resolve({ welcomed, code });
    ws.on("open", () => {
      if (token !== null) ws.send(JSON.stringify({ type: "hello", token }));
    });
    ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as { type?: string };
      if (m.type === "welcome") {
        welcomed = true;
        ws.close();
      }
    });
    ws.on("close", (code) => done(code));
    ws.on("error", () => done(-1));
    setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      done(-2);
    }, 8_000);
  });
}

// ─── A PAGE MUST NOT GET IN ─────────────────────────────────────────────

{
  const r = await tryConnect("https://evil.example.com", TOKEN);
  check(
    "A WEB PAGE IS REFUSED EVEN WITH THE RIGHT TOKEN — origin decides first",
    !r.welcomed,
    r,
  );
}

{
  const r = await tryConnect(EXT_ORIGIN, "WRONG-TOKEN-ENTIRELY");
  check("an extension with the wrong token is refused", !r.welcomed, r);
}

{
  const r = await tryConnect(EXT_ORIGIN, null);
  check(
    "…and one that never greets is dropped rather than left open",
    !r.welcomed && r.code !== -2,
    r,
  );
}

// ─── The paired extension works ─────────────────────────────────────────

{
  const ws = new WebSocket(URL, { origin: EXT_ORIGIN });
  const welcomed = await new Promise<boolean>((resolve) => {
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: TOKEN })));
    ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as { type?: string };
      if (m.type === "welcome") resolve(true);
    });
    ws.on("error", () => resolve(false));
    setTimeout(() => resolve(false), 8_000);
  });
  check("THE RIGHT TOKEN FROM AN EXTENSION IS LET IN", welcomed);
  check("…and the app reports a paired browser", bridgeStatus().connected, bridgeStatus());

  // A CDP call round-trips: the app asks, the extension answers, the caller
  // gets the result — which is all the transport is.
  const bridge = await import("../src/main/browser/bridge.js");
  const { getBridgeTransport, setBridgeSession, bridgeListTabs, bridgeOpenTab } = bridge;

  /** Stand in for the extension: echo CDP, and answer tab ops the way the real
   * one does — a `tabs` push, then the reply. */
  const seen: Record<string, unknown>[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(String(d)) as Record<string, unknown> & {
      id?: number;
      type?: string;
      op?: string;
      method?: string;
    };
    if (m.id == null) return;
    seen.push(m);
    if (m.type === "cdp") {
      ws.send(JSON.stringify({ id: m.id, ok: true, result: { echoed: m.method } }));
      return;
    }
    if (m.type === "tabs") {
      if (m.op === "list" || m.op === "open")
        ws.send(
          JSON.stringify({
            type: "tabs",
            tabs: [
              {
                id: 42,
                url: "https://example.com",
                title: "Example",
                session: m.session,
                active: true,
              },
            ],
          }),
        );
      ws.send(JSON.stringify({ id: m.id, ok: true, result: { tabId: 42, closed: 1 } }));
    }
  });

  setBridgeSession("Tesla Tear Sheet");
  const t = getBridgeTransport();
  const result = await t.send("Runtime.evaluate", { expression: "1+1" });
  check(
    "a CDP command reaches the browser and its answer comes back",
    result.echoed === "Runtime.evaluate",
    result,
  );

  // ── The session travels with every command ──────────────────────────
  //
  // It is the name on the tab group in the user's own browser, so a command
  // that forgets it would land the agent's tab loose among their tabs.
  {
    const cdp = seen.find((m) => m.type === "cdp");
    check(
      "EVERY COMMAND CARRIES ITS SESSION — that is what names the tab group",
      cdp?.session === "tesla-tear-sheet",
      cdp?.session,
    );
    check(
      "…slugged from the chat's title, not a uuid the user cannot read",
      bridge.bridgeSession() === "tesla-tear-sheet",
      bridge.bridgeSession(),
    );
  }

  // ── Several tabs at once, which is the point ─────────────────────────
  {
    const id = await bridgeOpenTab("https://example.com");
    check("the agent can open a tab of its own", id === 42, id);
    const tabs = await bridgeListTabs();
    check(
      "…and list what it holds, with the session on each",
      tabs.length === 1 && tabs[0].session === "tesla-tear-sheet",
      tabs,
    );
    const closed = await bridge.bridgeCloseSession();
    check("…and close the whole session in one go", closed === 1, closed);
    const op = seen.find((m) => m.op === "close_session");
    check("…which is one message, not a loop over tabs", !!op, op);
  }

  // An error from the browser must arrive as an error, not as a silent empty
  // result the caller mistakes for success.
  ws.removeAllListeners("message");
  ws.on("message", (d) => {
    const m = JSON.parse(String(d)) as { id?: number };
    if (m.id != null)
      ws.send(JSON.stringify({ id: m.id, ok: false, error: "no tab attached" }));
  });
  let threw = "";
  try {
    await t.send("Page.captureScreenshot");
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check("a refusal from the browser surfaces as an error", /no tab attached/.test(threw), threw);

  ws.close();
  await new Promise((r) => setTimeout(r, 300));
  check("…and closing the browser leaves nothing paired", !bridgeStatus().connected);
  check("…and takes its tabs off the books", bridgeStatus().tabs.length === 0);
}

// ─── With nobody paired, the tools say what to do ───────────────────────

{
  const { getBridgeTransport } = await import("../src/main/browser/bridge.js");
  let msg = "";
  try {
    getBridgeTransport();
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  check(
    "an unpaired bridge explains the fix rather than failing obscurely",
    /pairing code|extension/i.test(msg),
    msg,
  );
}

stopBridge();
console.log(failures ? `\n${failures} FAILED` : "\nONLY A PAIRED EXTENSION DRIVES THE BROWSER");
process.exit(failures ? 1 : 0);
