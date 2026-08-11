/**
 * Code Monet Bridge — the browser half.
 *
 * Holds one socket to the app (loopback only) and the tabs the agent owns.
 * Commands are either CDP replayed on one of those tabs, or a tabs-API intent
 * (open, navigate, select, close). Debugger events travel the other way.
 *
 * THE SESSION IS THE UNIT, and the model is Kimi WebBridge's, adopted rather
 * than reinvented after reading their shipped extension: every call carries a
 * session, the agent's tabs for that session live in a Chrome tab group
 * titled `agent:<session>`, and closing the session closes them together.
 * That is the row of purple `agent:…` groups you see beside your own tabs —
 * collapsible, closable, obviously not yours.
 *
 * It is also the permission model, and a better one than "attach one tab": a
 * command naming a tab the agent does not own is refused HERE, in the browser,
 * not merely discouraged in a prompt. Your own tabs are unreachable. That is
 * what makes it safe to point this at the browser you are signed into
 * everywhere.
 */

const PORT = 8317;
const URL = `ws://127.0.0.1:${PORT}`;
/** Domains enabled up front: Network and Log only report what happened AFTER
 * they were enabled, so turning them on when someone asks for logs would hand
 * back an empty file for a page that has been running for a minute. */
const DOMAINS = ["Page", "Runtime", "Network", "Log", "DOM"];
/** Their palette, and their reason for it: one colour per session so two
 * agents working at once are told apart at a glance. */
const PALETTE = ["purple", "green", "cyan", "orange", "pink", "yellow", "blue", "grey"];
let colourCursor = 0;

let socket = null;
let retryMs = 1000;

/** tabId → { session } for every tab the agent may touch. */
const agentTabs = new Map();
/** session → the tab commands go to when none is named. */
const currentBySession = new Map();
/** session → chrome tab group id */
const groupBySession = new Map();

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
    setBadge(String(agentTabs.size || ""), "#2a7d5f");
    void report();
  };

  socket.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    // Their keepalive, kept: an MV3 worker that hears nothing gets stopped.
    if (msg.type === "ping") return send({ type: "pong" });
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

// ─── Sessions and their tab groups ──────────────────────────────────────

/**
 * Put tabs into the session's group, creating it the first time.
 *
 * Their sequence, and each step earns its place: a group id we already know;
 * else a group with this title that survived a restart (so reconnecting does
 * not scatter a second `agent:x` beside the first); else a new one.
 */
async function groupTabs(tabIds, session, groupTitle) {
  if (!session) return;
  try {
    const known = groupBySession.get(session);
    if (known != null) {
      try {
        await chrome.tabGroups.get(known);
        await chrome.tabs.group({ tabIds, groupId: known });
        return;
      } catch {
        groupBySession.delete(session); // the user closed it
      }
    }
    const title = groupTitle || `agent:${session}`;
    const existing = await chrome.tabGroups.query({ title });
    if (existing.length > 0) {
      await chrome.tabs.group({ tabIds, groupId: existing[0].id });
      groupBySession.set(session, existing[0].id);
      return;
    }
    const gid = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(gid, {
      title,
      color: PALETTE[colourCursor++ % PALETTE.length],
      collapsed: false,
    });
    groupBySession.set(session, gid);
  } catch (err) {
    // Grouping is presentation. A window that refuses to group must not cost
    // the agent its tab.
    console.warn("[bridge] could not group the tab:", err);
  }
}

chrome.tabGroups.onRemoved.addListener((g) => {
  for (const [session, id] of groupBySession)
    if (id === g.id) {
      groupBySession.delete(session);
      break;
    }
});

async function attachDebugger(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    // Already ours is fine; DevTools owning it is not, and says so.
    if (!/already attached/i.test(String(err && err.message))) throw err;
  }
  for (const domain of DOMAINS) {
    try {
      await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`);
    } catch {
      /* a domain this target does not support is not fatal */
    }
  }
}

async function own(tabId, session, groupTitle) {
  agentTabs.set(tabId, { session: session || null });
  if (session) currentBySession.set(session, tabId);
  await attachDebugger(tabId);
  await groupTabs([tabId], session, groupTitle);
  setBadge(String(agentTabs.size), "#2a7d5f");
  await report();
}

async function disown(tabId) {
  const meta = agentTabs.get(tabId);
  agentTabs.delete(tabId);
  if (meta?.session && currentBySession.get(meta.session) === tabId) {
    const next = [...agentTabs.entries()].find(([, m]) => m.session === meta.session);
    if (next) currentBySession.set(meta.session, next[0]);
    else currentBySession.delete(meta.session);
  }
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already gone */
  }
  setBadge(String(agentTabs.size || ""), "#2a7d5f");
  await report();
}

/** Tell the app every tab the agent holds — this is what BrowserTabs lists. */
async function report() {
  const tabs = [];
  for (const [id, meta] of [...agentTabs]) {
    try {
      const t = await chrome.tabs.get(id);
      tabs.push({
        id,
        url: t.url,
        title: t.title,
        session: meta.session,
        active: currentBySession.get(meta.session) === id,
      });
    } catch {
      agentTabs.delete(id);
    }
  }
  send({ type: "tabs", tabs });
}

/** The tab a command acts on — and the refusal that keeps the rest of the
 * browser out of reach. */
function target(tabId, session) {
  const id = tabId ?? (session ? currentBySession.get(session) : undefined);
  if (id == null)
    throw new Error(
      "The agent has no tab in this session yet. Navigate to open one, or press Attach in the Code Monet Bridge popup to hand over the tab you are on.",
    );
  if (!agentTabs.has(id))
    throw new Error(
      `Tab ${id} does not belong to the agent. It can only act on tabs it opened, or ones you handed it with Attach.`,
    );
  return id;
}

/** Their guard, worth having: a chrome://, edge:// or extension page cannot be
 * driven or navigated, so a request to use one opens a fresh tab instead of
 * failing in a way that reads as the agent being broken. */
function undrivable(url) {
  return /^(chrome|edge|about|devtools|chrome-extension):/i.test(String(url || ""));
}

async function handle(msg) {
  if (msg.type === "cdp")
    return await chrome.debugger.sendCommand(
      { tabId: target(msg.tabId, msg.session) },
      msg.method,
      msg.params || {},
    );

  if (msg.type !== "tabs") throw new Error(`unknown message type: ${msg.type}`);

  switch (msg.op) {
    case "open": {
      // Not focused: opening a tab must not yank the screen away mid-sentence.
      // `activate` is the explicit "look at this".
      const tab = await chrome.tabs.create({ url: msg.url, active: false });
      await own(tab.id, msg.session, msg.group);
      return { tabId: tab.id };
    }
    case "navigate": {
      // No tab yet, an explicit newTab, or a page that cannot be driven — all
      // three mean this navigation is what opens one. The agent should not
      // have to know which case it is in.
      const held = msg.session ? currentBySession.get(msg.session) : undefined;
      let reuse = msg.tabId ?? held;
      if (reuse != null && agentTabs.has(reuse)) {
        const t = await chrome.tabs.get(reuse).catch(() => null);
        if (!t || undrivable(t.url)) reuse = undefined;
      } else reuse = undefined;

      if (msg.newTab || reuse == null) {
        const tab = await chrome.tabs.create({ url: msg.url, active: false });
        await own(tab.id, msg.session, msg.group);
        return { tabId: tab.id, opened: true };
      }
      await chrome.tabs.update(reuse, { url: msg.url });
      if (msg.session) currentBySession.set(msg.session, reuse);
      return { tabId: reuse, opened: false };
    }
    case "select": {
      const id = target(msg.tabId, msg.session);
      const meta = agentTabs.get(id);
      if (meta?.session) currentBySession.set(meta.session, id);
      await report();
      return { tabId: id };
    }
    case "activate": {
      const id = target(msg.tabId, msg.session);
      const tab = await chrome.tabs.get(id);
      await chrome.tabs.update(id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return {};
    }
    case "close": {
      const id = target(msg.tabId, msg.session);
      await disown(id);
      await chrome.tabs.remove(id);
      return {};
    }
    /** The whole session at once — their close_session, and the reason the
     * group is worth having: one action ends the agent's whole excursion. */
    case "close_session": {
      const ids = [...agentTabs.entries()]
        .filter(([, m]) => m.session === msg.session)
        .map(([id]) => id);
      for (const id of ids) await disown(id);
      if (ids.length) await chrome.tabs.remove(ids).catch(() => {});
      groupBySession.delete(msg.session);
      currentBySession.delete(msg.session);
      return { closed: ids.length };
    }
    case "reload": {
      await chrome.tabs.reload(target(msg.tabId, msg.session));
      return {};
    }
    case "back": {
      await chrome.tabs.goBack(target(msg.tabId, msg.session));
      return {};
    }
    case "forward": {
      await chrome.tabs.goForward(target(msg.tabId, msg.session));
      return {};
    }
    case "list": {
      await report();
      return {};
    }
    default:
      throw new Error(`unknown tabs op: ${msg.op}`);
  }
}

// The user closing a tab, or DevTools taking the session, ends the agent's
// hold on it — silently, because both are the user having the last word.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null && agentTabs.has(source.tabId)) void disown(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (agentTabs.has(tabId)) void disown(tabId);
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId != null && agentTabs.has(source.tabId))
    send({ type: "event", tabId: source.tabId, method, params: params || {} });
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === "attach") {
      await own(msg.tabId, msg.session || "handover", null);
      reply({ ok: true });
    } else if (msg.type === "detach") {
      await disown(msg.tabId);
      reply({ ok: true });
    } else if (msg.type === "release") {
      for (const id of [...agentTabs.keys()]) await disown(id);
      reply({ ok: true });
    } else if (msg.type === "status") {
      const { token } = await state();
      reply({
        paired: !!token,
        connected: !!socket && socket.readyState === WebSocket.OPEN,
        tabs: [...agentTabs.keys()],
        sessions: [...new Set([...agentTabs.values()].map((m) => m.session).filter(Boolean))],
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
