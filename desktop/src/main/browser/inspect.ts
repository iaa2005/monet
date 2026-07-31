/**
 * Design mode: the overlay that runs inside the page.
 *
 * It has to be injected into the page's MAIN world, and that is not a
 * preference. React attaches its fibre as an expando (`__reactFiber$…`) on the
 * DOM node itself, and expandos written by the page are invisible from an
 * isolated world — each world gets its own wrapper objects for the same nodes.
 * A <webview> preload therefore could not read a single prop. So: injected
 * through CDP, with the reply arriving on a Runtime binding rather than IPC.
 *
 * The script is inert until enable() is called, so nothing about a page's
 * behaviour changes while design mode is off.
 */

import { boxColors } from "@shared/selection-tones.js";
import type { BrowserTransport } from "./transport.js";

/** Inlined into the page so the boxes and the chips share one palette. */
const BOX_PALETTE = Array.from({ length: 6 }, (_, i) => boxColors(i));

/** Computed styles worth carrying — layout, type, colour. Not all 340. */
const STYLE_KEYS = [
  "display",
  "position",
  "width",
  "height",
  "margin",
  "padding",
  "flex-direction",
  "align-items",
  "justify-content",
  "gap",
  "grid-template-columns",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "color",
  "background-color",
  "border",
  "border-radius",
  "box-shadow",
  "opacity",
  "overflow",
  "text-align",
];

/**
 * Component names that are the framework talking, not the app.
 *
 * A Next.js tree puts a dozen of these between the DOM node and the component
 * somebody actually wrote, so the nearest named fibre is reliably
 * `InnerLayoutRouter` — a true answer and a useless one. Walking past them is
 * the difference between a chip that says ⟨Hero⟩ and one that says
 * ⟨OuterLayoutRouter⟩ on every element of the page.
 */
const FRAMEWORK_NAMES = [
  // Next.js app router
  "AppRouter", "InnerLayoutRouter", "OuterLayoutRouter", "RedirectBoundary",
  "RedirectErrorBoundary", "NotFoundBoundary", "NotFoundErrorBoundary",
  "LoadingBoundary", "ClientPageRoot", "ClientSegmentRoot", "ServerRoot",
  "RootLayout", "HTTPAccessFallbackBoundary", "MetadataTree", "ViewportBoundary",
  "OutletBoundary", "AsyncMetadata", "DevRootHTTPAccessFallbackBoundary",
  "PathnameContextProviderAdapter", "HotReload", "Router", "ReactDevOverlay",
  "ErrorBoundaryHandler", "ErrorBoundary", "Head", "PathnameProvider",
  // Generic plumbing
  "Suspense", "Fragment", "StrictMode", "Profiler", "Provider", "Consumer",
  "QueryClientProvider", "ThemeProvider", "Hydrate", "SafeHydrate",
];

/** Attributes that say what an element IS, as opposed to how it looks. */
const ATTR_KEYS = [
  "type",
  "name",
  "role",
  "href",
  "src",
  "alt",
  "title",
  "placeholder",
  "value",
  "aria-label",
  "aria-labelledby",
  "data-testid",
  "data-test",
  "disabled",
  "checked",
];

const OVERLAY_CSS = `
:host { all: initial; }
.box, .sel, .marquee {
  position: fixed; pointer-events: none; box-sizing: border-box;
}
.box { border: 1px solid #2563eb; background: rgba(37,99,235,.10); border-radius: 2px; }
.sel { border: 2px solid #7c3aed; background: rgba(124,58,237,.14); border-radius: 2px; }
.marquee { border: 1px dashed #7c3aed; background: rgba(124,58,237,.10); }
.label {
  position: fixed; pointer-events: none; white-space: nowrap;
  background: #2563eb; color: #fff; border-radius: 4px; padding: 2px 6px;
  font: 500 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  box-shadow: 0 1px 4px rgba(0,0,0,.25);
}
.hint {
  position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%);
  pointer-events: none; background: rgba(17,17,19,.92); color: #f4f6f8;
  border-radius: 7px; padding: 5px 11px;
  font: 500 11px/1.5 ui-sans-serif, system-ui, sans-serif;
  box-shadow: 0 2px 10px rgba(0,0,0,.35);
}
.hint b { color: #a5b4fc; font-weight: 600; }
`;

/**
 * The page-side script, as source.
 *
 * Written without template literals so it can live in one here — every `${` in
 * this file would otherwise be an interpolation into the TypeScript string.
 */
const OVERLAY_SCRIPT = `
(function () {
  if (window.__monetDesign) return;

  var STYLE_KEYS = ${JSON.stringify(STYLE_KEYS)};
  var ATTR_KEYS = ${JSON.stringify(ATTR_KEYS)};
  var FRAMEWORK_NAMES = ${JSON.stringify(FRAMEWORK_NAMES)};
  var CSS = ${JSON.stringify(OVERLAY_CSS)};
  var PALETTE = ${JSON.stringify(BOX_PALETTE)};
  // Where the palette stands, so a box matches the chip it is about to become.
  var toneBase = 0;
  function tone(i) { return PALETTE[Math.abs(toneBase + i) % PALETTE.length]; }

  var enabled = false;
  var host = null, root = null, hover = null, label = null, marquee = null, hint = null;
  var hoverEl = null;
  var selected = [];
  var drag = null;
  var frame = 0;

  function send(payload) {
    try {
      if (window.__monetBrowserEvent) window.__monetBrowserEvent(JSON.stringify(payload));
    } catch (e) { /* binding not installed */ }
  }

  // ── Identity ──────────────────────────────────────────────────────

  function xpathOf(el) {
    var parts = [];
    for (var n = el; n && n.nodeType === 1 && parts.length < 24; n = n.parentNode) {
      var tag = n.nodeName.toLowerCase();
      var i = 1;
      for (var s = n.previousElementSibling; s; s = s.previousElementSibling) {
        if (s.nodeName === n.nodeName) i++;
      }
      parts.unshift(tag + '[' + i + ']');
      if (n.parentNode === document.body) { parts.unshift('body'); break; }
    }
    return '/' + parts.join('/');
  }

  function classList(el) {
    var out = [];
    var cl = el.classList || [];
    for (var i = 0; i < cl.length && i < 12; i++) out.push(cl[i]);
    return out;
  }

  function selectorOf(el) {
    // An id is only useful if it actually is unique — frameworks generate
    // duplicates more often than you would hope.
    if (el.id && document.querySelectorAll('#' + CSS_escape(el.id)).length === 1) {
      return '#' + el.id;
    }
    var parts = [];
    for (var n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      var part = n.nodeName.toLowerCase();
      var cls = classList(n).filter(function (c) { return c.indexOf(':') < 0 && c.indexOf('[') < 0; });
      if (cls.length) part += '.' + cls.slice(0, 2).join('.');
      var same = n.parentElement
        ? Array.prototype.filter.call(n.parentElement.children, function (c) { return c.nodeName === n.nodeName; })
        : [];
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      parts.unshift(part);
      if (n.id) { parts[0] = '#' + n.id; break; }
    }
    return parts.join(' > ');
  }

  function CSS_escape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\\w-]/g, '\\\\$&');
  }

  // ── Framework ─────────────────────────────────────────────────────

  function fiberOf(el) {
    for (var k in el) {
      if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) {
        return el[k];
      }
    }
    return null;
  }

  function nameOfType(t) {
    if (!t) return null;
    if (typeof t === 'string') return null;
    if (typeof t === 'function') return t.displayName || t.name || null;
    if (typeof t === 'object') {
      return t.displayName || t.name ||
        (t.render && (t.render.displayName || t.render.name)) ||
        (t.type && nameOfType(t.type)) || null;
    }
    return null;
  }

  function usefulName(n) {
    if (!n || n.length < 2 || n === 'Unknown') return false;
    if (FRAMEWORK_NAMES.indexOf(n) >= 0) return false;
    // Minified builds hand out single letters and _c3; a Provider or a
    // Boundary is somebody's plumbing whatever the prefix.
    if (/^[_$]/.test(n)) return false;
    if (/(Provider|Consumer|Boundary|Context)$/.test(n)) return false;
    // withRouter(Foo) / memo(Foo) — take the inner name, which is the answer.
    return true;
  }

  function unwrapName(n) {
    var m = /^[A-Za-z]+\((.+)\)$/.exec(n || '');
    return m ? m[1] : n;
  }

  function reactInfo(el) {
    var f = fiberOf(el);
    var depth = 0;
    var fallback = null;
    while (f && depth++ < 40) {
      var n = unwrapName(nameOfType(f.type));
      if (usefulName(n)) {
        return { framework: 'react', component: n, props: f.memoizedProps };
      }
      // Keep the first named thing as a last resort: a page built entirely out
      // of framework wrappers should still name something.
      if (!fallback && n && n.length > 1) {
        fallback = { framework: 'react', component: n, props: f.memoizedProps };
      }
      f = f.return;
    }
    return fallback;
  }

  function vueInfo(el) {
    var c = el.__vueParentComponent;
    if (c && c.type) {
      var n = c.type.name || c.type.__name;
      if (n) return { framework: 'vue', component: n, props: c.props };
    }
    if (el.__vue__ && el.__vue__.$options) {
      var n2 = el.__vue__.$options.name;
      if (n2) return { framework: 'vue', component: n2, props: el.__vue__.$props };
    }
    return null;
  }

  function frameworkInfo(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var info = reactInfo(n) || vueInfo(n);
      if (info) return info;
    }
    return null;
  }

  /** Props, flattened and capped — a fibre holds functions and cycles. */
  function safeProps(props) {
    if (!props || typeof props !== 'object') return undefined;
    var out = {};
    var budget = 700;
    var keys = Object.keys(props);
    for (var i = 0; i < keys.length && budget > 0; i++) {
      var k = keys[i];
      if (k === 'children') continue;
      var v = props[k];
      var s;
      if (v === null || v === undefined) s = null;
      else if (typeof v === 'function') s = '[fn]';
      else if (typeof v === 'object') {
        try { s = JSON.stringify(v).slice(0, 120); } catch (e) { s = '[object]'; }
      } else s = v;
      out[k] = s;
      budget -= String(k).length + String(s).length + 4;
    }
    return out;
  }

  /** file:line, when a dev plugin left it in the DOM. */
  function sourceOf(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var f = n.getAttribute('data-inspector-file') || n.getAttribute('data-source-file');
      if (f) {
        var l = n.getAttribute('data-inspector-line') || n.getAttribute('data-source-line');
        return l ? f + ':' + l : f;
      }
      var v = n.getAttribute('data-v-inspector');
      if (v) return v;
    }
    return null;
  }

  // ── Serialising one element ───────────────────────────────────────

  function describe(el) {
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    var styles = {};
    for (var i = 0; i < STYLE_KEYS.length; i++) {
      var v = cs.getPropertyValue(STYLE_KEYS[i]);
      if (v) styles[STYLE_KEYS[i]] = v.trim();
    }
    var attrs = {};
    for (var j = 0; j < ATTR_KEYS.length; j++) {
      if (el.hasAttribute(ATTR_KEYS[j])) attrs[ATTR_KEYS[j]] = el.getAttribute(ATTR_KEYS[j]) || '';
    }
    var info = frameworkInfo(el) || {};
    var parent = el.parentElement;

    return {
      xpath: xpathOf(el),
      selector: selectorOf(el),
      tag: el.nodeName.toLowerCase(),
      id: el.id || undefined,
      classes: classList(el),
      attrs: attrs,
      text: (el.innerText || el.value || '').trim().slice(0, 300),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      pageRect: { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height },
      styles: styles,
      framework: info.framework,
      component: info.component,
      props: safeProps(info.props),
      source: sourceOf(el) || undefined,
      parent: parent ? parent.nodeName.toLowerCase() +
        (classList(parent).length ? '.' + classList(parent).slice(0, 2).join('.') : '') : undefined,
      siblingCount: parent ? parent.children.length : undefined
    };
  }

  function payload(extra) {
    var p = {
      url: location.href,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 },
      elements: selected.map(describe)
    };
    for (var k in extra) p[k] = extra[k];
    return p;
  }

  // ── Overlay ───────────────────────────────────────────────────────

  function ensureOverlay() {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement('div');
    host.setAttribute('data-monet-overlay', '');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    root = host.attachShadow({ mode: 'closed' });
    var style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    hover = document.createElement('div'); hover.className = 'box';
    label = document.createElement('div'); label.className = 'label';
    marquee = document.createElement('div'); marquee.className = 'marquee';
    hint = document.createElement('div'); hint.className = 'hint';
    hint.innerHTML = '<b>click</b> select · <b>ctrl+click</b> add · ' +
      '<b>alt+click</b> send · <b>shift+drag</b> region · <b>enter</b> send · <b>esc</b> exit';
    root.appendChild(hover); root.appendChild(label);
    root.appendChild(marquee); root.appendChild(hint);
    document.documentElement.appendChild(host);
  }

  function place(node, r) {
    node.style.display = 'block';
    node.style.left = r.x + 'px';
    node.style.top = r.y + 'px';
    node.style.width = Math.max(0, r.w) + 'px';
    node.style.height = Math.max(0, r.h) + 'px';
  }

  function labelFor(el) {
    var info = frameworkInfo(el);
    var r = el.getBoundingClientRect();
    var name = info && info.component
      ? '<' + info.component + '>'
      : el.nodeName.toLowerCase() + (classList(el).length ? '.' + classList(el)[0] : '');
    return name + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
  }

  function paint() {
    if (!enabled) return;
    ensureOverlay();

    // Selected boxes, one node each, reused between paints.
    var boxes = root.querySelectorAll('.sel');
    while (boxes.length < selected.length) {
      var b = document.createElement('div'); b.className = 'sel';
      root.appendChild(b);
      boxes = root.querySelectorAll('.sel');
    }
    for (var i = 0; i < boxes.length; i++) {
      if (i < selected.length) {
        var sr = selected[i].getBoundingClientRect();
        place(boxes[i], { x: sr.x, y: sr.y, w: sr.width, h: sr.height });
        var c = tone(i);
        boxes[i].style.borderColor = c.border;
        boxes[i].style.background = c.fill;
      } else {
        boxes[i].style.display = 'none';
      }
    }

    if (hoverEl && selected.indexOf(hoverEl) < 0) {
      var r = hoverEl.getBoundingClientRect();
      place(hover, { x: r.x, y: r.y, w: r.width, h: r.height });
      var hc = tone(selected.length);
      hover.style.borderColor = hc.border;
      hover.style.background = hc.fill;
      label.style.background = hc.label;
      label.style.display = 'block';
      label.textContent = labelFor(hoverEl);
      // Above the element, unless that would be off the top of the screen.
      var top = r.y - 22 < 2 ? r.y + r.height + 4 : r.y - 22;
      label.style.left = Math.max(2, Math.min(r.x, innerWidth - 220)) + 'px';
      label.style.top = top + 'px';
    } else {
      hover.style.display = 'none';
      label.style.display = 'none';
    }

    if (drag && drag.moved) {
      place(marquee, {
        x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1),
        w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0)
      });
    } else {
      marquee.style.display = 'none';
    }
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(function () { frame = 0; paint(); });
  }

  // ── Events ────────────────────────────────────────────────────────

  function elementAt(e) {
    // The overlay is pointer-events:none, so this returns the page's own node.
    var el = document.elementFromPoint(e.clientX, e.clientY);
    return el && el !== document.documentElement && el !== document.body ? el : null;
  }

  function onMove(e) {
    if (!enabled) return;
    if (drag) {
      drag.x1 = e.clientX; drag.y1 = e.clientY;
      if (Math.abs(drag.x1 - drag.x0) > 3 || Math.abs(drag.y1 - drag.y0) > 3) drag.moved = true;
      schedule();
      return;
    }
    var el = elementAt(e);
    if (el !== hoverEl) { hoverEl = el; schedule(); }
  }

  function onDown(e) {
    if (!enabled) return;
    e.preventDefault(); e.stopPropagation();
    if (e.shiftKey) {
      drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, moved: false };
      // Ask for a frame NOW: an animated page will have moved on by the time
      // the drag ends, and the annotation would describe a state that is gone.
      send({ type: 'freeze' });
    }
  }

  function onUp(e) {
    if (!enabled) return;
    e.preventDefault(); e.stopPropagation();
    if (drag) {
      var d = drag; drag = null;
      if (d.moved) {
        // Viewport coordinates, not document ones: the frame this annotates is
        // a capture of the viewport, so that is the space it must be cut in.
        var region = {
          x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1),
          w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0)
        };
        send({ type: 'selection', target: 'composer', data: payload({ region: region }) });
      }
      schedule();
    }
  }

  function onClick(e) {
    if (!enabled) return;
    e.preventDefault(); e.stopPropagation();
    if (e.shiftKey) return;
    var el = elementAt(e);
    if (!el) return;

    if (e.ctrlKey || e.metaKey) {
      var at = selected.indexOf(el);
      if (at >= 0) selected.splice(at, 1); else selected.push(el);
    } else {
      selected = [el];
    }
    schedule();

    if (e.altKey && selected.length) {
      send({ type: 'selection', target: 'composer', data: payload({}) });
    }
  }

  function onKey(e) {
    if (!enabled) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (selected.length) { selected = []; schedule(); }
      else { disable(); send({ type: 'exit' }); }
      return;
    }
    if (e.key === 'Enter' || (e.key === 'l' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault(); e.stopPropagation();
      if (selected.length) send({ type: 'selection', target: 'composer', data: payload({}) });
    }
  }

  var handlers = [
    ['mousemove', onMove], ['mousedown', onDown], ['mouseup', onUp],
    ['click', onClick], ['dblclick', swallow], ['contextmenu', swallow],
    ['keydown', onKey]
  ];

  function swallow(e) {
    if (!enabled) return;
    e.preventDefault(); e.stopPropagation();
  }

  function enable() {
    if (enabled) return;
    enabled = true;
    for (var i = 0; i < handlers.length; i++)
      window.addEventListener(handlers[i][0], handlers[i][1], true);
    addEventListener('scroll', schedule, true);
    addEventListener('resize', schedule, true);
    ensureOverlay();
    schedule();
  }

  function disable() {
    if (!enabled) return;
    enabled = false;
    for (var i = 0; i < handlers.length; i++)
      window.removeEventListener(handlers[i][0], handlers[i][1], true);
    removeEventListener('scroll', schedule, true);
    removeEventListener('resize', schedule, true);
    selected = []; hoverEl = null; drag = null;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null; root = null;
  }

  window.__monetDesign = {
    setToneBase: function (n) { toneBase = n | 0; schedule(); },
    enable: enable,
    disable: disable,
    clear: function () { selected = []; schedule(); },
    isOn: function () { return enabled; }
  };
})();
`;

const BINDING = "__monetBrowserEvent";

/** What the page sends back on the binding. */
export type InspectMessage =
  | { type: "freeze" }
  | { type: "exit" }
  | {
      type: "selection";
      target: "composer";
      data: Record<string, unknown>;
    };

interface Installed {
  designOn: boolean;
  off: () => void;
}

const installed = new Map<string, Installed>();

/**
 * Put the overlay in the page and keep it there.
 *
 * `Page.addScriptToEvaluateOnNewDocument` covers every future navigation; the
 * Runtime.evaluate covers the document that is already loaded. Both are needed
 * — one alone leaves either the current page or the next one without it.
 */
export async function installInspector(
  t: BrowserTransport,
  onMessage: (msg: InspectMessage) => void,
): Promise<void> {
  const existing = installed.get(t.targetId);
  if (existing) return;

  const off = t.onEvent((method, params) => {
    if (method === "Runtime.bindingCalled") {
      const p = params as { name?: string; payload?: string };
      if (p.name !== BINDING || !p.payload) return;
      try {
        onMessage(JSON.parse(p.payload) as InspectMessage);
      } catch {
        /* a malformed payload is not worth crashing a turn over */
      }
      return;
    }
    // A new document gets a fresh JS world: the script is re-injected by CDP,
    // but its `enabled` flag starts false, so design mode has to be re-armed.
    if (method === "Page.loadEventFired") {
      const state = installed.get(t.targetId);
      if (state?.designOn) void evaluate(t, "window.__monetDesign && window.__monetDesign.enable()");
    }
  });

  await t.send("Runtime.addBinding", { name: BINDING });
  await t.send("Page.addScriptToEvaluateOnNewDocument", { source: OVERLAY_SCRIPT });
  await evaluate(t, OVERLAY_SCRIPT);

  installed.set(t.targetId, { designOn: false, off });
}

async function evaluate(t: BrowserTransport, expression: string): Promise<void> {
  try {
    await t.send("Runtime.evaluate", { expression, returnByValue: true });
  } catch {
    /* mid-navigation: the next load re-runs it anyway */
  }
}

export async function setDesignMode(
  t: BrowserTransport,
  on: boolean,
  onMessage: (msg: InspectMessage) => void,
): Promise<void> {
  await installInspector(t, onMessage);
  const state = installed.get(t.targetId);
  if (state) state.designOn = on;
  await evaluate(
    t,
    on
      ? "window.__monetDesign && window.__monetDesign.enable()"
      : "window.__monetDesign && window.__monetDesign.disable()",
  );
}

/** Tell the page where the palette stands, so its next box matches its chip. */
export async function setToneBase(t: BrowserTransport, base: number): Promise<void> {
  await evaluate(
    t,
    `window.__monetDesign && window.__monetDesign.setToneBase(${Math.max(0, base | 0)})`,
  );
}

export function forgetInspector(targetId: string): void {
  installed.get(targetId)?.off();
  installed.delete(targetId);
}
