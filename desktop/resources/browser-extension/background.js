/**
 * Code Monet Bridge — the browser half.
 *
 * Holds one socket to the app (loopback only) and one chrome.debugger session
 * on ONE tab the user picked. Everything the app asks for is either a CDP
 * command replayed on that tab, or a tabs-API intent (navigate, reload, back,
 * activate). Debugger events travel the other way.
 *
 * Two rules that are not decoration:
 *   - nothing happens until the user attaches a tab from the popup. The
 *     extension never picks a tab on its own, so "the agent can drive my
 *     browser" is always a thing the user did, on a page they were looking at;
 *   - the socket is opened only when a pairing code is stored, and the app
 *     hangs up on anything that cannot produce it.
 */

const PORT = 8317;
const URL = `ws://127.0.0.1:${PORT}`;
/** Domains enabled up front: Network and Log only report what happened AFTER
 * they were enabled, so turning them on when someone asks for logs would hand
 * back an empty file for a page that has been running for a minute. */
const DOMAINS = ["Page", "Runtime", "Network", "Log", "DOM"];

let socket = null;
let attachedTabId = null;
let retryMs = 1000;

const state = async () => (await chrome.storage.local.get(["token", "enabled"])) || {};

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

function send(msg) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

async function connect() {
  const { token, enabled } = await state();
  if (!token || enabled === false) {
    setBadge("", "#888888");
    return;
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))
    return;

  socket = new WebSocket(URL);

  socket.onopen = () => {
    retryMs = 1000;
    send({ type: "hello", token, version: chrome.runtime.getManifest().version });
    setBadge("•", "#2a7d5f");
    if (attachedTabId != null) reportAttached(attachedTabId);
  };

  socket.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "welcome") return;
    if (msg.id == null) return;
    try {
      const result = await handle(msg);
      send({ id: msg.id, ok: true, result: result || {} });
    } catch (err) {
      send({ id: msg.id, ok: false, error: String((err && err.message) || err) });
    }
  };

  socket.onclose = (ev) => {
    socket = null;
    // 4001/4003/4008 are refusals — a wrong or missing pairing code. Retrying
    // in a tight loop would just hammer the app, and the user has to act.
    const refused = ev.code === 4001 || ev.code === 4003 || ev.code === 4008;
    setBadge(refused ? "!" : "", refused ? "#a33" : "#888888");
    if (refused) return;
    retryMs = Math.min(retryMs * 2, 30_000);
    setTimeout(connect, retryMs);
  };

  socket.onerror = () => {
    /* onclose does the retry */
  };
}

/** The tab the app is allowed to touch, or a refusal that says what to do. */
function target() {
  if (attachedTabId == null)
    throw new Error(
      "No tab is attached. Open the Code Monet Bridge popup on the tab you want the agent to use and press Attach.",
    );
  return { tabId: attachedTabId };
}

async function handle(msg) {
  if (msg.type === "cdp") {
    return await chrome.debugger.sendCommand(target(), msg.method, msg.params || {});
  }
  if (msg.type === "tabs") {
    const { tabId } = target();
    switch (msg.op) {
      case "navigate":
        await chrome.tabs.update(tabId, { url: msg.url });
        return {};
      case "reload":
        await chrome.tabs.reload(tabId);
        return {};
      case "back":
        await chrome.tabs.goBack(tabId);
        return {};
      case "forward":
        await chrome.tabs.goForward(tabId);
        return {};
      case "activate": {
        const tab = await chrome.tabs.get(tabId);
        await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return {};
      }
      case "info": {
        const tab = await chrome.tabs.get(tabId);
        return { id: tab.id, url: tab.url, title: tab.title };
      }
      default:
        throw new Error(`unknown tabs op: ${msg.op}`);
    }
  }
  throw new Error(`unknown message type: ${msg.type}`);
}

async function reportAttached(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    send({ type: "attached", tab: { id: tab.id, url: tab.url, title: tab.title } });
  } catch {
    /* the tab went away */
  }
}

async function attach(tabId) {
  if (attachedTabId === tabId) return;
  if (attachedTabId != null) await detach();
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabId = tabId;
  for (const domain of DOMAINS) {
    try {
      await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`);
    } catch {
      /* a domain this target does not support is not fatal */
    }
  }
  setBadge("▶", "#2a7d5f");
  await reportAttached(tabId);
  await connect();
}

async function detach() {
  const tabId = attachedTabId;
  attachedTabId = null;
  send({ type: "detached" });
  setBadge(socket ? "•" : "", "#2a7d5f");
  if (tabId == null) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already gone */
  }
}

// The user closing the tab, or DevTools taking the session, ends the hold.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === attachedTabId) {
    attachedTabId = null;
    send({ type: "detached" });
    setBadge(socket ? "•" : "", "#2a7d5f");
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === attachedTabId) {
    attachedTabId = null;
    send({ type: "detached" });
  }
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === attachedTabId) send({ type: "event", method, params: params || {} });
});

// The popup is the only way in.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === "attach") {
      await attach(msg.tabId);
      reply({ ok: true });
    } else if (msg.type === "detach") {
      await detach();
      reply({ ok: true });
    } else if (msg.type === "status") {
      const { token } = await state();
      reply({
        paired: !!token,
        connected: !!socket && socket.readyState === WebSocket.OPEN,
        attachedTabId,
      });
    } else if (msg.type === "pair") {
      await chrome.storage.local.set({ token: msg.token, enabled: true });
      try {
        socket?.close();
      } catch {
        /* fine */
      }
      socket = null;
      retryMs = 1000;
      await connect();
      reply({ ok: true });
    } else reply({ ok: false });
  })();
  return true; // async reply
});

// An MV3 service worker is stopped when idle; the alarm wakes it to reconnect.
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
void connect();
