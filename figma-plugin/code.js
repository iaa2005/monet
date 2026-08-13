/**
 * Code Monet → Figma.
 *
 * Builds the app's screens on the "Code Monet" page of the design file, out of
 * the tokens already there: the Color / Radius variable collections, the text
 * styles, and the icon components imported from the app's own SVG sources.
 *
 * Re-runnable. Everything it makes is named, and every run deletes the previous
 * copies first — so the loop is "edit this file, hit Run again", not "undo
 * fifty times".
 *
 * Sizes are the app's real CSS pixels: --titlebar-h is 36 here because it is 36
 * in globals.css, the sidebar is 320 because it is w-80. The frame is 1440×900
 * rather than the 1792×1155 the app happened to be running at — a canonical
 * desktop artboard, with every number inside it still meaning a CSS pixel.
 */

async function build() {
  const t0 = Date.now();
  const notes = [];

  // ── page ───────────────────────────────────────────────────────────
  await figma.loadAllPagesAsync();
  let page = figma.root.children.find((p) => p.name === "Code Monet");
  if (!page) {
    page = figma.createPage();
    page.name = "Code Monet";
  }
  await figma.setCurrentPageAsync(page);

  // ── tokens ─────────────────────────────────────────────────────────
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const V = {};
  let lightCol = null;
  let darkCol = null;
  for (const c of collections) {
    if (c.name === "Color") lightCol = c;
    if (c.name === "Color Dark") darkCol = c;
    if (c.name !== "Color" && c.name !== "Radius") continue;
    for (const id of c.variableIds) {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (v) V[v.name] = v;
    }
  }
  if (!V["surface/card"]) {
    figma.closePlugin("Не нашёл коллекцию Color — сначала должны быть переменные.");
    return;
  }

  const T = {};
  for (const s of await figma.getLocalTextStylesAsync()) T[s.name] = s;

  const iconsSection = page.findOne((n) => n.type === "SECTION" && n.name === "Icons");
  if (!iconsSection) {
    figma.closePlugin("Не нашёл секцию Icons.");
    return;
  }
  const ICON = {};
  for (const c of iconsSection.children) {
    if (c.type === "COMPONENT" && c.name.indexOf("icon/") === 0) {
      ICON[c.name.slice(5)] = c;
    }
  }

  // ── fonts ──────────────────────────────────────────────────────────
  await Promise.all([
    figma.loadFontAsync({ family: "Inter", style: "Regular" }),
    figma.loadFontAsync({ family: "Inter", style: "Medium" }),
    figma.loadFontAsync({ family: "Inter", style: "Semi Bold" }),
    figma.loadFontAsync({ family: "Cascadia Code", style: "Regular" }),
  ]);

  // The display face is the app's own TTF. If it is installed, the wordmark
  // stops being a stand-in; if it is not, Inter carries on and the run says so.
  const available = await figma.listAvailableFontsAsync();
  const boundedStyles = available
    .filter((f) => f.fontName.family === "Bounded")
    .map((f) => f.fontName.style);
  if (boundedStyles.length && T["Wordmark/17 Semi Bold"]) {
    const pick =
      ["Semi Bold", "SemiBold", "Bold", "Medium", "Regular"].find((s) => boundedStyles.indexOf(s) >= 0) ||
      boundedStyles[0];
    const face = { family: "Bounded", style: pick };
    await figma.loadFontAsync(face);
    T["Wordmark/17 Semi Bold"].fontName = face;
    notes.push("Bounded " + pick);
  } else {
    notes.push("Bounded не установлен — вордмарк на Inter");
  }

  // ── helpers ────────────────────────────────────────────────────────
  const pending = [];

  function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  }
  function solid(hex, opacity) {
    const p = { type: "SOLID", color: rgb(hex) };
    if (opacity !== undefined) p.opacity = opacity;
    return p;
  }
  function bound(name) {
    return figma.variables.setBoundVariableForPaint(
      { type: "SOLID", color: { r: 0, g: 0, b: 0 } },
      "color",
      V[name],
    );
  }
  function fill(node, name, opacity) {
    const p = bound(name);
    node.fills = [opacity === undefined ? p : Object.assign({}, p, { opacity: opacity })];
  }
  function stroke(node, name) {
    node.strokes = [bound(name)];
  }
  function edges(node, top, right, bottom, left) {
    node.strokeTopWeight = top;
    node.strokeRightWeight = right;
    node.strokeBottomWeight = bottom;
    node.strokeLeftWeight = left;
  }
  function radius(node, name) {
    for (const k of ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"]) {
      node.setBoundVariable(k, V[name]);
    }
  }
  /**
   * An auto-layout frame, hugging on both axes.
   *
   * `figma.createAutoLayout` only exists inside the MCP sandbox, not in the
   * real Plugin API — calling it here is what hung the first run.
   */
  function AL(dir, props) {
    const f = figma.createFrame();
    f.layoutMode = dir;
    f.primaryAxisSizingMode = "AUTO";
    f.counterAxisSizingMode = "AUTO";
    f.itemSpacing = 0;
    f.paddingLeft = 0;
    f.paddingRight = 0;
    f.paddingTop = 0;
    f.paddingBottom = 0;
    f.fills = [];
    f.strokes = [];
    f.clipsContent = false;
    if (props) {
      if (props.name) f.name = props.name;
      if (props.itemSpacing !== undefined) f.itemSpacing = props.itemSpacing;
    }
    return f;
  }
  /** resize() resets both axes to FIXED, so FILL has to be set after it. */
  function fixThen(node, w, h, fillH, fillV) {
    node.resize(w, h);
    if (fillH) node.layoutSizingHorizontal = "FILL";
    if (fillV) node.layoutSizingVertical = "FILL";
  }
  function box(w, h) {
    const f = figma.createFrame();
    f.fills = [];
    f.resize(w, h);
    return f;
  }

  /** An icon instance: sized, untinted-frame, stroke weight scaled with the box. */
  function ico(name, size, colorName, literalHex) {
    const c = ICON[name];
    if (!c) throw new Error("нет иконки " + name);
    const i = c.createInstance();
    i.resize(size, size);
    i.fills = [];
    i.name = name;
    const k = size / 24;
    for (const n of i.findAll(() => true)) {
      if ("strokeWeight" in n && typeof n.strokeWeight === "number" && n.strokeWeight > 0) {
        n.strokeWeight = n.strokeWeight * k;
      }
      if ("strokes" in n && Array.isArray(n.strokes) && n.strokes.length) {
        n.strokes = literalHex ? [solid(literalHex)] : [bound(colorName)];
      }
      if ("fills" in n && Array.isArray(n.fills) && n.fills.length) {
        n.fills = literalHex ? [solid(literalHex)] : [bound(colorName)];
      }
    }
    return i;
  }

  function txt(chars, styleName, colorName, literalHex) {
    const t = figma.createText();
    t.characters = chars;
    if (T[styleName]) pending.push(t.setTextStyleIdAsync(T[styleName].id));
    t.fills = literalHex ? [solid(literalHex)] : [bound(colorName)];
    return t;
  }
  /** Wrapping text needs an explicit width — FILL alone collapses the node. */
  function para(chars, styleName, colorName, w) {
    const t = txt(chars, styleName, colorName);
    t.textAutoResize = "HEIGHT";
    t.resize(w, t.height);
    return t;
  }
  function bigTxt(chars, size, style, hex) {
    const t = figma.createText();
    t.fontName = { family: "Inter", style: style };
    t.characters = chars;
    t.fontSize = size;
    t.lineHeight = { unit: "PIXELS", value: Math.round(size * 1.25) };
    t.letterSpacing = { unit: "PERCENT", value: -1 };
    t.fills = [solid(hex)];
    return t;
  }
  function dot(size, colorName, literalHex) {
    const e = figma.createEllipse();
    e.resize(size, size);
    e.fills = literalHex ? [solid(literalHex)] : [bound(colorName)];
    e.strokes = [];
    return e;
  }
  function spacer(parent) {
    const s = box(8, 8);
    s.name = "spacer";
    parent.appendChild(s);
    s.layoutSizingHorizontal = "FILL";
    s.layoutSizingVertical = "FILL";
    return s;
  }
  function fillsHoriz(node) {
    node.layoutSizingHorizontal = "FILL";
    return node;
  }

  const CHART_UP = "#26A17B";
  const CHART_DOWN = "#EF5350";
  const MAX_PINK = "#D6469E";
  const JSON_AMBER = "#D98A1F";
  const PY_BLUE = "#3776AB";

  /**
   * Add an icon component the file does not have yet, in lucide's own geometry.
   * New sections need new glyphs, and nothing else should have to change.
   */
  function ensureIcon(name, inner, sw) {
    if (ICON[name]) return ICON[name];
    const svg =
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#131414" stroke-width="' +
      (sw || 2) +
      '" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
      inner + "</svg>";
    const f = figma.createNodeFromSvg(svg);
    f.name = "icon/" + name;
    f.resize(24, 24);
    const c = figma.createComponentFromNode(f);
    c.name = "icon/" + name;
    c.fills = [];
    iconsSection.appendChild(c);
    const comps = iconsSection.children.filter(function (x) { return x.type === "COMPONENT"; });
    let x0 = Infinity, y0 = Infinity;
    for (const k of comps) { if (k !== c) { x0 = Math.min(x0, k.x); y0 = Math.min(y0, k.y); } }
    const slot = comps.length - 1;
    c.x = x0 + (slot % 8) * 64;
    c.y = y0 + Math.floor(slot / 8) * 64;
    ICON[name] = c;
    return c;
  }

  /**
   * Read the design back out — the only command here that writes nothing.
   *
   * Going the other way (Figma → code) needs the real numbers, not a look at a
   * screenshot: which radius token, what padding, which weight. This walks the
   * selection and copies a compact outline to the clipboard.
   */
  async function dumpSelection() {
    const varName = {};
    for (const c of await figma.variables.getLocalVariableCollectionsAsync()) {
      for (const id of c.variableIds) {
        const v = await figma.variables.getVariableByIdAsync(id);
        if (v) varName[v.id] = v.name;
      }
    }
    const styleName = {};
    for (const s of await figma.getLocalTextStylesAsync()) styleName[s.id] = s.name;

    function hex2(c) {
      function h(x) { const s = Math.round(x * 255).toString(16); return s.length < 2 ? "0" + s : s; }
      return "#" + (h(c.r) + h(c.g) + h(c.b)).toUpperCase();
    }
    function paint(list, bv, key) {
      if (!Array.isArray(list) || !list.length) return null;
      const p = list[0];
      if (p.visible === false) return null;
      let name = null;
      if (p.boundVariables && p.boundVariables.color) name = varName[p.boundVariables.color.id];
      const base = name || (p.type === "SOLID" ? hex2(p.color) : p.type);
      return base + (p.opacity !== undefined && p.opacity < 1 ? "@" + Math.round(p.opacity * 100) + "%" : "");
    }
    function radiusOf(n) {
      if (!("cornerRadius" in n)) return null;
      const bv = n.boundVariables || {};
      const named = ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"]
        .map(function (k) { return bv[k] ? varName[bv[k].id] : null; });
      if (named[0] && named.every(function (x) { return x === named[0]; })) return named[0];
      if (typeof n.cornerRadius === "number") return n.cornerRadius === 0 ? null : String(n.cornerRadius);
      return [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius].join("/");
    }

    const lines = [];
    // Async because documentAccess: "dynamic-page" forbids the synchronous
    // `instance.mainComponent` — it has to be awaited.
    async function walk(n, depth, maxDepth) {
      const p = [];
      p.push(n.type === "TEXT" ? '"' + n.characters.slice(0, 44).replace(/\n/g, "⏎") + '"' : n.name);
      p.push(n.type === "INSTANCE" ? "INST" : n.type.slice(0, 5));
      p.push(Math.round(n.width) + "x" + Math.round(n.height));
      if ("layoutSizingHorizontal" in n && n.layoutSizingHorizontal) {
        const sz = n.layoutSizingHorizontal[0] + n.layoutSizingVertical[0];
        if (sz !== "FF" || true) p.push("sz=" + sz);
      }
      if ("layoutMode" in n && n.layoutMode && n.layoutMode !== "NONE") {
        p.push("AL=" + n.layoutMode[0]);
        p.push("pad=" + [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].join(","));
        p.push("gap=" + n.itemSpacing);
        if (n.primaryAxisAlignItems !== "MIN") p.push("main=" + n.primaryAxisAlignItems);
        if (n.counterAxisAlignItems !== "MIN") p.push("cross=" + n.counterAxisAlignItems);
      }
      const r = radiusOf(n);
      if (r) p.push("r=" + r);
      const f = paint(n.fills);
      if (f) p.push("fill=" + f);
      const s = paint(n.strokes);
      if (s) {
        const edges = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"]
          .map(function (k) { return k in n ? n[k] : n.strokeWeight; });
        p.push("stroke=" + s + ":" + (edges.every(function (x) { return x === edges[0]; }) ? edges[0] : edges.join("/")));
      }
      if (n.type === "TEXT") {
        if (n.textStyleId && styleName[n.textStyleId]) p.push("style=" + styleName[n.textStyleId]);
        const fn = n.fontName;
        if (fn && fn !== figma.mixed) p.push("font=" + fn.family + "/" + fn.style);
        if (n.fontSize !== figma.mixed) p.push("size=" + n.fontSize);
        if (n.lineHeight !== figma.mixed && n.lineHeight.unit !== "AUTO") p.push("lh=" + n.lineHeight.value + (n.lineHeight.unit === "PERCENT" ? "%" : ""));
        if (n.letterSpacing !== figma.mixed && n.letterSpacing.value) p.push("ls=" + n.letterSpacing.value + (n.letterSpacing.unit === "PERCENT" ? "%" : ""));
        if (n.textAlignHorizontal !== "LEFT") p.push("align=" + n.textAlignHorizontal);
      }
      let mcName = null;
      if (n.type === "INSTANCE") {
        const mc = await n.getMainComponentAsync();
        mcName = mc ? mc.name : null;
        if (mcName) p.push("of=" + mcName);
      }
      if (n.opacity !== undefined && n.opacity < 1) p.push("op=" + n.opacity);
      if (n.visible === false) p.push("HIDDEN");
      if (Array.isArray(n.effects) && n.effects.length && n.effects[0].visible !== false) {
        const e = n.effects[0];
        p.push("shadow=" + Math.round(e.offset ? e.offset.y : 0) + "/" + e.radius + "/" + (e.spread || 0) + "/" + Math.round((e.color ? e.color.a : 0) * 100) + "%");
      }
      lines.push(new Array(depth + 1).join("  ") + p.join(" "));

      const isIcon = mcName && mcName.indexOf("icon/") === 0;
      if (isIcon || depth >= maxDepth) return;
      if ("children" in n) for (const k of n.children) await walk(k, depth + 1, maxDepth);
    }

    const sel = figma.currentPage.selection;
    if (!sel.length) {
      lines.push("=== VARIABLES ===");
      for (const c of await figma.variables.getLocalVariableCollectionsAsync()) {
        lines.push("-- " + c.name);
        for (const id of c.variableIds) {
          const v = await figma.variables.getVariableByIdAsync(id);
          if (!v) continue;
          const val = v.valuesByMode[c.modes[0].modeId];
          lines.push("  " + v.name + " = " + (val && val.r !== undefined ? hex2(val) : JSON.stringify(val)));
        }
      }
      lines.push("=== TEXT STYLES ===");
      for (const s of await figma.getLocalTextStylesAsync()) {
        lines.push("  " + s.name + " : " + s.fontName.family + "/" + s.fontName.style +
          " size=" + s.fontSize +
          " lh=" + (s.lineHeight.unit === "AUTO" ? "auto" : s.lineHeight.value) +
          " ls=" + (s.letterSpacing.value || 0) + (s.letterSpacing.unit === "PERCENT" ? "%" : ""));
      }
      lines.push("=== TOP LEVEL ===");
      for (const n of figma.currentPage.children) {
        lines.push("  " + n.name + " [" + n.type + "] " + Math.round(n.width) + "x" + Math.round(n.height) + " @" + Math.round(n.x) + "," + Math.round(n.y));
      }
    } else {
      for (const n of sel) await walk(n, 0, 12);
    }

    const text = lines.join("\n");
    figma.showUI(
      "<style>body{font:12px ui-sans-serif;margin:0;padding:10px;background:#1e1e1e;color:#ddd}" +
      "textarea{width:100%;height:150px;background:#111;color:#9cdcfe;border:1px solid #333;font:11px ui-monospace}" +
      "button{margin-top:8px;padding:6px 12px}</style>" +
      "<div id=s>копирую…</div><textarea id=t></textarea><button onclick=go()>Копировать ещё раз</button>" +
      "<script>" +
      "var d='';onmessage=function(e){d=e.data.pluginMessage;document.getElementById('t').value=d;go()};" +
      "function go(){var t=document.getElementById('t');t.focus();t.select();" +
      "var ok=document.execCommand('copy');" +
      "document.getElementById('s').textContent=ok?('скопировано, '+d.length+' символов'):'не вышло — выдели и Ctrl+C';}" +
      "</script>",
      { width: 420, height: 260, title: "Выгрузка" },
    );
    figma.ui.postMessage(text);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Settings — the modal, on its own, at 900×920
  // ═══════════════════════════════════════════════════════════════════
  async function buildSettings() {
    const NEW_ICONS = {
      "settings": '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
      "text-cursor": '<path d="M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h1"/><path d="M7 22h1a4 4 0 0 0 4-4v-1"/><path d="M7 2h1a4 4 0 0 1 4 4v1"/>',
      "boxes": '<path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/><path d="m7 16.5-4.74-2.85"/><path d="m7 16.5 5-3"/><path d="M7 16.5v5.17"/><path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/><path d="m17 16.5-5-3"/><path d="m17 16.5 4.74-2.85"/><path d="M17 16.5v5.17"/><path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/><path d="M12 8 7.26 5.15"/><path d="m12 8 4.74-2.85"/><path d="M12 13.5V8"/>',
      "mouse-pointer-click": '<path d="m9 9 5 12 1.8-5.2L21 14Z"/><path d="M7.2 2.2 8 5.1"/><path d="m5.1 8-2.9-.8"/><path d="M14 4.1 12 6"/><path d="m6 12-1.9 2"/>',
      "brain": '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/>',
      "sun": '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
      "sliders-horizontal": '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
      "book-marked": '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><polyline points="10 2 10 10 13 7 16 10 16 2"/>',
      "bot": '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
      "file-scan": '<path d="M20 10V7l-5-5H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h4"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 14a2 2 0 0 0-2 2"/><path d="M20 14a2 2 0 0 1 2 2"/><path d="M20 22a2 2 0 0 0 2-2"/><path d="M16 22a2 2 0 0 1-2-2"/>',
      "plug": '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
      "cpu": '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
      "cloud": '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
      "trash-2": '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    };
    let added = 0;
    for (const k of Object.keys(NEW_ICONS)) {
      if (!ICON[k]) { ensureIcon(k, NEW_ICONS[k]); added++; }
    }

    const MADE = ["4 · Settings — General", "5 · Settings — Voice", "Settings/Nav item"];
    for (const n of page.children.slice()) {
      if (MADE.indexOf(n.name) >= 0) n.remove();
    }

    const MW = 900, MH = 920, NAVW = 208, PADX = 26;
    const CONTENT_W = MW - NAVW - PADX * 2;

    // ── the repeated nav row ─────────────────────────────────────────
    const navItem = AL("HORIZONTAL", { name: "Settings/Nav item", itemSpacing: 9 });
    navItem.counterAxisAlignItems = "CENTER";
    navItem.paddingLeft = 10;
    navItem.paddingRight = 10;
    navItem.resize(184, 32);
    navItem.layoutSizingHorizontal = "FIXED";
    navItem.layoutSizingVertical = "FIXED";
    navItem.fills = [];
    radius(navItem, "radius/md");
    navItem.appendChild(ico("settings", 15, "text/muted-foreground"));
    navItem.appendChild(txt("General", "Body/13", "text/foreground"));
    const navComp = figma.createComponentFromNode(navItem);
    navComp.name = "Settings/Nav item";
    navComp.description = "32px settings nav row. Active = --accent fill.";

    function navRow(label, icon, active) {
      const i = navComp.createInstance();
      i.name = label;
      const g = i.children[0];
      g.swapComponent(ICON[icon]);
      g.resize(15, 15);
      g.fills = [];
      for (const n of g.findAll(function () { return true; })) {
        if ("strokeWeight" in n && typeof n.strokeWeight === "number" && n.strokeWeight > 0) {
          n.strokeWeight = n.strokeWeight * (15 / 24);
        }
        if ("strokes" in n && Array.isArray(n.strokes) && n.strokes.length) {
          n.strokes = [bound(active ? "text/foreground" : "text/muted-foreground")];
        }
        if ("fills" in n && Array.isArray(n.fills) && n.fills.length) {
          n.fills = [bound(active ? "text/foreground" : "text/muted-foreground")];
        }
      }
      i.children[1].characters = label;
      if (active) fill(i, "surface/accent");
      return i;
    }

    // ── little parts ─────────────────────────────────────────────────
    function heading(s) {
      const t = figma.createText();
      t.fontName = { family: "Inter", style: "Semi Bold" };
      t.characters = s;
      t.fontSize = 16;
      t.lineHeight = { unit: "PIXELS", value: 22 };
      t.letterSpacing = { unit: "PERCENT", value: -1 };
      t.fills = [bound("text/foreground")];
      return t;
    }
    function rule(parent) {
      const r = figma.createRectangle();
      r.resize(CONTENT_W, 1);
      r.strokes = [];
      fill(r, "line/border");
      parent.appendChild(r);
      r.layoutSizingHorizontal = "FILL";
      return r;
    }
    function boxed(w, h, name) {
      const b = AL("HORIZONTAL", { name: name || "Field", itemSpacing: 6 });
      b.counterAxisAlignItems = "CENTER";
      b.paddingLeft = 10;
      b.paddingRight = 10;
      b.resize(w, h);
      b.layoutSizingHorizontal = "FIXED";
      b.layoutSizingVertical = "FIXED";
      b.fills = [];
      b.strokeWeight = 1;
      stroke(b, "line/input");
      radius(b, "radius/md");
      return b;
    }
    function field(value, w) {
      const b = boxed(w, 32, "Input");
      b.appendChild(txt(value, "Body/13", "text/foreground"));
      return b;
    }
    function picker(value) {
      const b = AL("HORIZONTAL", { name: "Select", itemSpacing: 6 });
      b.counterAxisAlignItems = "CENTER";
      b.paddingLeft = 10;
      b.paddingRight = 8;
      b.paddingTop = 6;
      b.paddingBottom = 6;
      b.fills = [];
      b.strokeWeight = 1;
      stroke(b, "line/input");
      radius(b, "radius/md");
      b.appendChild(txt(value, "Body/13", "text/foreground"));
      b.appendChild(ico("chevron-down", 14, "text/muted-foreground"));
      return b;
    }
    function toggle(on) {
      const t = AL("HORIZONTAL", { name: "Toggle" });
      t.counterAxisAlignItems = "CENTER";
      t.primaryAxisAlignItems = on ? "MAX" : "MIN";
      t.paddingLeft = 2;
      t.paddingRight = 2;
      t.resize(40, 22);
      t.layoutSizingHorizontal = "FIXED";
      t.layoutSizingVertical = "FIXED";
      fill(t, on ? "brand/brand" : "surface/accent");
      radius(t, "radius/full");
      const knob = figma.createEllipse();
      knob.resize(18, 18);
      knob.fills = [solid("#FFFFFF")];
      knob.strokes = [];
      knob.effects = [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.18 }, offset: { x: 0, y: 1 }, radius: 2, spread: 0, visible: true, blendMode: "NORMAL" }];
      t.appendChild(knob);
      return t;
    }
    /** A row where a label sits left and one control sits right. */
    function settingRow(parent, label, control, h) {
      const r = AL("HORIZONTAL", { name: label, itemSpacing: 12 });
      r.counterAxisAlignItems = "CENTER";
      r.fills = [];
      parent.appendChild(r);
      fixThen(r, CONTENT_W, h || 56, true, false);
      const l = txt(label, "Body/13", "text/foreground");
      r.appendChild(l);
      l.layoutSizingHorizontal = "FILL";
      r.appendChild(control);
      return r;
    }

    // ── the modal shell, shared by both screens ──────────────────────
    function modal(name, x, activeSection) {
      const m = AL("HORIZONTAL", { name: name, itemSpacing: 0 });
      m.resize(MW, MH);
      m.layoutSizingHorizontal = "FIXED";
      m.layoutSizingVertical = "FIXED";
      fill(m, "surface/card");
      radius(m, "radius/2xl");
      m.strokeWeight = 1;
      stroke(m, "line/border");
      m.clipsContent = true;
      m.effects = [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.16 }, offset: { x: 0, y: 18 }, radius: 48, spread: -10, visible: true, blendMode: "NORMAL" }];
      page.appendChild(m);
      m.x = x;
      m.y = 1400;

      const nav = AL("VERTICAL", { name: "Nav", itemSpacing: 0 });
      fill(nav, "surface/background");
      nav.paddingLeft = 12;
      nav.paddingRight = 12;
      nav.paddingTop = 12;
      nav.strokeRightWeight = 1;
      nav.strokeTopWeight = 0;
      nav.strokeBottomWeight = 0;
      nav.strokeLeftWeight = 0;
      stroke(nav, "line/border");
      m.appendChild(nav);
      nav.resize(NAVW, MH);
      nav.layoutSizingVertical = "FILL";

      const search = boxed(184, 30, "Search");
      search.appendChild(ico("search", 14, "text/muted-foreground"));
      search.appendChild(txt("Search settings", "Body/13", "text/muted-foreground"));
      nav.appendChild(search);
      search.layoutSizingHorizontal = "FILL";

      const groups = [
        ["Settings", [
          ["General", "settings"], ["Editor", "text-cursor"], ["Providers", "boxes"],
          ["Sandbox", "container"], ["Automation", "mouse-pointer-click"], ["Voice", "mic"],
          ["Memory", "brain"], ["Reflect", "sun"], ["Advanced", "sliders-horizontal"],
        ]],
        ["Customize", [
          ["Skills", "book-marked"], ["Agents", "bot"], ["Obsidian", "obsidian"],
          ["OCR Scanner", "file-scan"], ["Connectors", "boxes"], ["MCP Servers", "plug"],
        ]],
      ];
      for (const [group, items] of groups) {
        const gl = txt(group, "UI/12", "text/muted-foreground");
        const wrap = AL("VERTICAL", { name: group, itemSpacing: 0 });
        wrap.fills = [];
        wrap.paddingTop = 16;
        wrap.paddingBottom = 4;
        wrap.paddingLeft = 10;
        wrap.appendChild(gl);
        nav.appendChild(wrap);
        wrap.layoutSizingHorizontal = "FILL";
        for (const [label, icon] of items) {
          const r = navRow(label, icon, label === activeSection);
          nav.appendChild(r);
          r.layoutSizingHorizontal = "FILL";
        }
      }

      const content = AL("VERTICAL", { name: "Content", itemSpacing: 0 });
      content.fills = [];
      content.paddingLeft = PADX;
      content.paddingRight = PADX;
      content.paddingTop = 32;
      content.clipsContent = true;
      m.appendChild(content);
      content.layoutSizingHorizontal = "FILL";
      content.layoutSizingVertical = "FILL";

      const close = AL("HORIZONTAL", { name: "Close" });
      close.primaryAxisAlignItems = "CENTER";
      close.counterAxisAlignItems = "CENTER";
      close.resize(26, 26);
      close.layoutSizingHorizontal = "FIXED";
      close.layoutSizingVertical = "FIXED";
      close.fills = [];
      close.appendChild(ico("x", 15, "text/muted-foreground"));
      m.appendChild(close);
      close.layoutPositioning = "ABSOLUTE";
      close.x = MW - 44;
      close.y = 18;
      return { frame: m, content: content };
    }

    // ── 4 · General ──────────────────────────────────────────────────
    const g = modal("4 · Settings — General", 0, "General");
    {
      const c = g.content;
      c.appendChild(heading("Profile"));

      const avatarRow = AL("HORIZONTAL", { name: "Avatar", itemSpacing: 12 });
      avatarRow.counterAxisAlignItems = "CENTER";
      avatarRow.fills = [];
      c.appendChild(avatarRow);
      fixThen(avatarRow, CONTENT_W, 116, true, false);
      const al = txt("Avatar", "Body/13", "text/foreground");
      avatarRow.appendChild(al);
      al.layoutSizingHorizontal = "FILL";
      const av = figma.createEllipse();
      av.resize(96, 96);
      fill(av, "surface/accent");
      av.strokes = [];
      avatarRow.appendChild(av);
      rule(c);

      settingRow(c, "Full name", field("Aleksandr Ivanov", 258), 60);
      rule(c);
      settingRow(c, "What should Code Monet call you?", field("Aleksandr", 258), 60);
      rule(c);
      settingRow(c, "What best describes your work?", picker("Student"), 60);
      rule(c);

      const instr = AL("VERTICAL", { name: "Instructions", itemSpacing: 3 });
      instr.fills = [];
      instr.paddingTop = 18;
      instr.paddingBottom = 6;
      c.appendChild(instr);
      instr.layoutSizingHorizontal = "FILL";
      instr.appendChild(txt("Instructions for Code Monet", "Body/13", "text/foreground"));
      const ih = para("Code Monet will keep these in mind across chats (injected into every chat's system prompt).", "UI/12", "text/muted-foreground", CONTENT_W);
      instr.appendChild(ih);
      ih.layoutSizingHorizontal = "FILL";
      const ta = AL("VERTICAL", { name: "Textarea" });
      ta.paddingLeft = 12;
      ta.paddingTop = 10;
      ta.paddingRight = 12;
      fill(ta, "surface/muted");
      ta.strokeWeight = 1;
      stroke(ta, "line/input");
      radius(ta, "radius/lg");
      ta.appendChild(txt("e.g. ask clarifying questions before giving detailed answers", "Body/13", "text/muted-foreground"));
      instr.appendChild(ta);
      fixThen(ta, CONTENT_W, 76, true, false);
      const gap1 = box(8, 22); gap1.name = "gap"; c.appendChild(gap1); gap1.layoutSizingHorizontal = "FILL";

      c.appendChild(heading("Power"));
      const pw = para("How this device behaves while Code Monet is running.", "Body/13", "text/muted-foreground", CONTENT_W);
      c.appendChild(pw);
      pw.layoutSizingHorizontal = "FILL";
      const gap2 = box(8, 12); gap2.name = "gap"; c.appendChild(gap2); gap2.layoutSizingHorizontal = "FILL";

      const keep = AL("HORIZONTAL", { name: "Keep awake", itemSpacing: 14 });
      keep.paddingLeft = 14; keep.paddingRight = 14; keep.paddingTop = 13; keep.paddingBottom = 13;
      keep.fills = [];
      keep.strokeWeight = 1;
      stroke(keep, "line/border");
      radius(keep, "radius/lg");
      const keepMeta = AL("VERTICAL", { name: "Meta", itemSpacing: 3 });
      keepMeta.fills = [];
      keepMeta.appendChild(txt("Keep awake", "Body/13", "text/foreground"));
      const kd = para("Stop this computer going to sleep on its own, so a long run isn't cut off mid-task and a scheduled routine actually fires. The screen still turns off as usual. It can't wake a sleeping machine, and it won't override closing the lid.", "Body/13", "text/muted-foreground", CONTENT_W - 100);
      keepMeta.appendChild(kd);
      kd.layoutSizingHorizontal = "FILL";
      keep.appendChild(keepMeta);
      keepMeta.layoutSizingHorizontal = "FILL";
      keep.appendChild(toggle(false));
      c.appendChild(keep);
      keep.layoutSizingHorizontal = "FILL";
      const gap3 = box(8, 26); gap3.name = "gap"; c.appendChild(gap3); gap3.layoutSizingHorizontal = "FILL";

      c.appendChild(heading("Appearance"));
      const ap = para("Choose how Code Monet looks on this device.", "Body/13", "text/muted-foreground", CONTENT_W);
      c.appendChild(ap);
      ap.layoutSizingHorizontal = "FILL";
      const gap4 = box(8, 12); gap4.name = "gap"; c.appendChild(gap4); gap4.layoutSizingHorizontal = "FILL";

      const themes = AL("HORIZONTAL", { name: "Themes", itemSpacing: 14 });
      themes.fills = [];
      c.appendChild(themes);
      themes.layoutSizingHorizontal = "FILL";
      for (const [label, on, chrome, sheet] of [["Light", true, "#F2F2F3", "#FFFFFF"], ["Dark", false, "#121212", "#1F1F1F"]]) {
        const card = AL("VERTICAL", { name: label, itemSpacing: 10 });
        card.paddingLeft = 12; card.paddingRight = 12; card.paddingTop = 10; card.paddingBottom = 12;
        card.fills = [];
        card.strokeWeight = 1;
        stroke(card, on && V["brand/edge"] ? "brand/edge" : "line/border");
        radius(card, "radius/lg");
        const head = AL("HORIZONTAL", { name: "Head", itemSpacing: 8 });
        head.counterAxisAlignItems = "CENTER";
        head.fills = [];
        const hl = txt(label, "Body/13", "text/foreground");
        head.appendChild(hl);
        card.appendChild(head);
        head.layoutSizingHorizontal = "FILL";
        hl.layoutSizingHorizontal = "FILL";
        if (on) head.appendChild(ico("check", 15, "brand/brand"));
        const prev = figma.createRectangle();
        prev.resize(100, 74);
        prev.fills = [solid(chrome)];
        prev.strokes = [solid(sheet)];
        prev.strokeWeight = 8;
        prev.strokeAlign = "INSIDE";
        prev.cornerRadius = 6;
        card.appendChild(prev);
        prev.layoutSizingHorizontal = "FILL";
        themes.appendChild(card);
        card.layoutSizingHorizontal = "FILL";
      }
    }

    // ── 5 · Voice ────────────────────────────────────────────────────
    const v = modal("5 · Settings — Voice", MW + 120, "Voice");
    {
      const c = v.content;

      /** One engine / model card. Selected ones carry the brand wash. */
      function pick(opts) {
        const card = AL("HORIZONTAL", { name: opts.title, itemSpacing: 11 });
        card.counterAxisAlignItems = opts.blurb ? "MIN" : "CENTER";
        card.paddingLeft = 12; card.paddingRight = 12; card.paddingTop = 9; card.paddingBottom = 9;
        if (opts.on && V["brand/wash"]) fill(card, "brand/wash"); else card.fills = [];
        card.strokeWeight = 1;
        stroke(card, opts.on && V["brand/edge"] ? "brand/edge" : "line/border");
        radius(card, "radius/lg");
        if (opts.glyph) {
          const chip = AL("HORIZONTAL", { name: "Glyph" });
          chip.primaryAxisAlignItems = "CENTER";
          chip.counterAxisAlignItems = "CENTER";
          chip.resize(28, 28);
          chip.layoutSizingHorizontal = "FIXED";
          chip.layoutSizingVertical = "FIXED";
          if (opts.on && V["brand/wash"]) fill(chip, "brand/wash"); else fill(chip, "surface/muted");
          radius(chip, "radius/md");
          chip.appendChild(ico(opts.glyph, 15, opts.on ? "brand/brand" : "text/muted-foreground"));
          card.appendChild(chip);
        }
        const meta = AL("VERTICAL", { name: "Meta", itemSpacing: 2 });
        meta.fills = [];
        meta.appendChild(txt(opts.title, "Body/13", "text/foreground"));
        const sub = para(opts.sub, "UI/12", "text/muted-foreground", CONTENT_W - 120);
        meta.appendChild(sub);
        sub.layoutSizingHorizontal = "FILL";
        if (opts.blurb) {
          const b = para(opts.blurb, "UI/12", "text/muted-foreground", CONTENT_W - 120);
          meta.appendChild(b);
          b.layoutSizingHorizontal = "FILL";
        }
        card.appendChild(meta);
        meta.layoutSizingHorizontal = "FILL";
        const tail = AL("HORIZONTAL", { name: "Actions", itemSpacing: 12 });
        tail.counterAxisAlignItems = "CENTER";
        tail.fills = [];
        if (opts.on) tail.appendChild(ico("check", 15, "brand/brand"));
        if (opts.trash) tail.appendChild(ico("trash-2", 15, "text/muted-foreground"));
        if (opts.get) tail.appendChild(ico("download", 15, "text/muted-foreground"));
        card.appendChild(tail);
        c.appendChild(card);
        card.layoutSizingHorizontal = "FILL";
        return card;
      }
      function gap(h) {
        const s = box(8, h);
        s.name = "gap";
        c.appendChild(s);
        s.layoutSizingHorizontal = "FILL";
      }

      c.appendChild(heading("Dictation"));
      const dd = para("Speech to text for the mic button and Voice Mode. On-device engines need no key and keep audio on this machine.", "Body/13", "text/muted-foreground", CONTENT_W);
      c.appendChild(dd);
      dd.layoutSizingHorizontal = "FILL";
      gap(12);

      pick({ title: "On-device — GigaAM", sub: "Best Russian quality. Runs here, no key, nothing leaves the machine.", glyph: "cpu", on: true });
      gap(6);
      pick({ title: "On-device — Whisper", sub: "Multilingual, in the renderer via WASM. Smaller models, lighter machines.", glyph: "cpu" });
      gap(6);
      pick({ title: "Cloud — OpenAI-compatible", sub: "Any endpoint that speaks the transcriptions API. Needs a key; audio is uploaded.", glyph: "cloud" });
      gap(10);

      pick({ title: "GigaAM v3 RNN-T + punctuation", sub: "Русский (+ English words inside Russian speech) · 232 MB · punctuation", blurb: "Best Russian quality, writes punctuation itself. Handles Russian mixed with English terms.", glyph: "cpu", on: true, trash: true });
      gap(6);
      pick({ title: "GigaAM v3 CTC + punctuation", sub: "Русский (+ English words inside Russian speech) · 225 MB · punctuation", glyph: "cpu", get: true });
      gap(6);
      pick({ title: "GigaAM Multilingual CTC — large", sub: "70+ (ru, en, kk, ky, uz…) · 592 MB", glyph: "cpu", get: true });
      gap(6);
      pick({ title: "GigaAM Multilingual CTC", sub: "70+ (ru, en, kk, ky, uz…) · 225 MB", glyph: "cpu", get: true });
      gap(8);
      const note = para("Runs on your machine, no key and no network once downloaded.", "UI/12", "text/muted-foreground", CONTENT_W);
      c.appendChild(note);
      note.layoutSizingHorizontal = "FILL";
      gap(24);

      c.appendChild(heading("Voice"));
      const vd = para("Supertonic 3 — on-device, 31 languages, expression tags. One shared model (~398 MB), then each voice is a 0.3 MB download.", "Body/13", "text/muted-foreground", CONTENT_W);
      c.appendChild(vd);
      vd.layoutSizingHorizontal = "FILL";
      gap(12);

      const lang = AL("HORIZONTAL", { name: "Speech language", itemSpacing: 14 });
      lang.counterAxisAlignItems = "CENTER";
      lang.paddingLeft = 14; lang.paddingRight = 12; lang.paddingTop = 11; lang.paddingBottom = 11;
      lang.fills = [];
      lang.strokeWeight = 1;
      stroke(lang, "line/border");
      radius(lang, "radius/lg");
      const lm = AL("VERTICAL", { name: "Meta", itemSpacing: 2 });
      lm.fills = [];
      lm.appendChild(txt("Speech language", "Body/13", "text/foreground"));
      lm.appendChild(txt("The accent the voice reads with. On auto it follows each sentence's own script.", "UI/12", "text/muted-foreground"));
      lang.appendChild(lm);
      lm.layoutSizingHorizontal = "FILL";
      lang.appendChild(picker("Auto"));
      c.appendChild(lang);
      lang.layoutSizingHorizontal = "FILL";
      gap(6);

      // The voice portraits are generated pixel art in the app; here they are a
      // deterministic 6×6 grid in the same palette, so the row reads right
      // without pretending to be the real thing.
      let s2 = 7;
      function rnd2() { s2 = (s2 * 1103515245 + 12345) % 2147483648; return s2 / 2147483648; }
      function portrait() {
        const p = figma.createFrame();
        p.name = "Portrait";
        p.resize(30, 30);
        p.fills = [solid("#EFF1F3")];
        p.clipsContent = true;
        p.cornerRadius = 4;
        const palette = ["#1481F5", "#8FA1B3", "#D7DDE3", "#0D4E9E"];
        for (let i = 0; i < 36; i++) {
          const cell = figma.createRectangle();
          cell.resize(5, 5);
          cell.strokes = [];
          cell.fills = [solid(palette[Math.floor(rnd2() * palette.length)])];
          p.appendChild(cell);
          cell.x = (i % 6) * 5;
          cell.y = Math.floor(i / 6) * 5;
        }
        return p;
      }
      for (const [nm, desc] of [["Sarah", "Calm, slightly low; steady and composed."], ["Lily", "Bright and light; quick, friendly delivery."]]) {
        const card = AL("HORIZONTAL", { name: nm, itemSpacing: 11 });
        card.counterAxisAlignItems = "CENTER";
        card.paddingLeft = 12; card.paddingRight = 12; card.paddingTop = 10; card.paddingBottom = 10;
        card.fills = [];
        card.strokeWeight = 1;
        stroke(card, "line/border");
        radius(card, "radius/lg");
        card.appendChild(portrait());
        const meta = AL("VERTICAL", { name: "Meta", itemSpacing: 2 });
        meta.fills = [];
        meta.appendChild(txt(nm, "Body/13", "text/foreground"));
        meta.appendChild(txt(desc, "UI/12", "text/muted-foreground"));
        card.appendChild(meta);
        meta.layoutSizingHorizontal = "FILL";
        c.appendChild(card);
        card.layoutSizingHorizontal = "FILL";
        gap(6);
      }
    }

    page.appendChild(navComp);
    navComp.x = -1750;
    navComp.y = 1900;

    await Promise.all(pending);
    figma.viewport.scrollAndZoomIntoView([g.frame, v.frame]);
    return { added: added, ids: [g.frame.id, v.frame.id] };
  }

  // Both washes are premixed colours rather than an opacity on a bound paint,
  // for the reason spelled out at ensureColor: the Plugin API drops the opacity
  // and the thing renders at full strength.
  V["brand/wash"] = await ensureColor(lightCol, "brand/wash", "#E3F0FE");
  await ensureColor(darkCol, "brand/wash", "#1D2833");
  V["brand/edge"] = await ensureColor(lightCol, "brand/edge", "#ADD3FB");
  await ensureColor(darkCol, "brand/edge", "#274667");

  const cmd = figma.command || "app";
  // Read-only: no closePlugin, because the UI has to stay up long enough to
  // hand the text to the clipboard.
  if (cmd === "dump") {
    await dumpSelection();
    return;
  }
  if (cmd === "settings") {
    const r = await buildSettings();
    figma.closePlugin(
      "Настройки собраны за " + ((Date.now() - t0) / 1000).toFixed(1) + "s · иконок добавлено: " + r.added,
    );
    return;
  }

  // ── clean up the previous run ──────────────────────────────────────
  const BUILT = [
    "1 · Chat + Artifacts", "2 · Chat + Files", "3 · Chat + Terminal",
    "Chat column", "Panel/Artifacts", "Panel/Files", "Panel/Terminal",
    "Panel/Tasks", "Tasks/Row", "Files/Row", "Dock/Tab",
  ];
  for (const n of page.children.slice()) {
    if (BUILT.indexOf(n.name) >= 0) n.remove();
  }

  const titlebarComp = page.findOne((n) => n.type === "COMPONENT" && n.name === "Titlebar");
  const sidebarComp = page.findOne((n) => n.type === "COMPONENT" && n.name === "Sidebar");
  if (!titlebarComp || !sidebarComp) {
    figma.closePlugin("Не нашёл компоненты Titlebar / Sidebar.");
    return;
  }

  // The app's own viewport, in CSS pixels: 1792×1152 is what the window
  // measures on the machine this was drawn from, so the sidebar is 320 and the
  // chat and dock each take 736 — the same split the running app has.
  const SCREEN_W = 1792;
  const SCREEN_H = 1152;
  const CHAT_W = 736;
  const DOCK_W = 736;
  const BODY_H = SCREEN_H - 36;
  const TOP_PANEL_H = 556;

  // ═══════════════════════════════════════════════════════════════════
  //  Dock tab strip — shared by all four panels
  // ═══════════════════════════════════════════════════════════════════
  function dockStrip(tabs) {
    const strip = AL("HORIZONTAL", { name: "Tab strip", itemSpacing: 0 });
    fill(strip, "surface/muted");
    strip.counterAxisAlignItems = "CENTER";
    strip.paddingRight = 6;
    edges(strip, 0, 0, 1, 0);
    stroke(strip, "line/border");
    for (const [label, active] of tabs) {
      const tab = AL("HORIZONTAL", { name: label, itemSpacing: 8 });
      tab.counterAxisAlignItems = "CENTER";
      tab.primaryAxisAlignItems = "CENTER";
      tab.paddingLeft = 14;
      tab.paddingRight = 10;
      if (active) fill(tab, "surface/card");
      else tab.fills = [];
      edges(tab, 0, 1, active ? 0 : 1, 0);
      stroke(tab, "line/border");
      tab.appendChild(txt(label, "Body/13", active ? "text/foreground" : "text/muted-foreground"));
      tab.appendChild(ico("x", 13, "text/muted-foreground"));
      strip.appendChild(tab);
      tab.layoutSizingVertical = "FILL";
    }
    spacer(strip);
    for (const g of ["maximize-2", "external-link"]) {
      const b = AL("HORIZONTAL", { name: g });
      b.primaryAxisAlignItems = "CENTER";
      b.counterAxisAlignItems = "CENTER";
      b.resize(26, 26);
      b.layoutSizingHorizontal = "FIXED";
      b.layoutSizingVertical = "FIXED";
      b.fills = [];
      b.appendChild(ico(g, 14, "text/muted-foreground"));
      strip.appendChild(b);
    }
    return strip;
  }

  function panelShell(name, tabs) {
    const p = AL("VERTICAL", { name: name, itemSpacing: 0 });
    p.resize(DOCK_W, TOP_PANEL_H);
    p.layoutSizingHorizontal = "FIXED";
    p.layoutSizingVertical = "FIXED";
    fill(p, "surface/card");
    p.clipsContent = true;
    edges(p, 0, 0, 0, 1);
    stroke(p, "line/border");
    const strip = dockStrip(tabs);
    p.appendChild(strip);
    fixThen(strip, DOCK_W, 32, true, false);
    return p;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Panel/Artifacts
  // ═══════════════════════════════════════════════════════════════════
  const artifacts = panelShell("Panel/Artifacts", [["Terminal", false], ["Artifacts", true], ["Files", false]]);
  {
    const head = AL("HORIZONTAL", { name: "Header", itemSpacing: 0 });
    head.counterAxisAlignItems = "CENTER";
    head.paddingLeft = 14;
    head.paddingRight = 12;
    head.fills = [];
    artifacts.appendChild(head);
    fixThen(head, DOCK_W, 36, true, false);
    const h = txt("Artifacts", "Label/13 Medium", "text/foreground");
    head.appendChild(h);
    fillsHoriz(h);
    const dl = AL("HORIZONTAL", { name: "Download all", itemSpacing: 6 });
    dl.counterAxisAlignItems = "CENTER";
    dl.fills = [];
    dl.appendChild(ico("download", 14, "text/muted-foreground"));
    dl.appendChild(txt("Download all", "Body/13", "text/muted-foreground"));
    head.appendChild(dl);

    const body = AL("VERTICAL", { name: "List", itemSpacing: 8 });
    body.fills = [];
    body.paddingLeft = 12;
    body.paddingRight = 12;
    body.paddingTop = 4;
    artifacts.appendChild(body);
    fillsHoriz(body);

    const card = AL("HORIZONTAL", { name: "aapl_1h.json", itemSpacing: 12 });
    card.counterAxisAlignItems = "CENTER";
    card.paddingLeft = 12;
    card.paddingRight = 12;
    card.paddingTop = 10;
    card.paddingBottom = 10;
    fill(card, "surface/card");
    card.strokeWeight = 1;
    stroke(card, "line/border");
    radius(card, "radius/lg");

    const chip = AL("HORIZONTAL", { name: "Type" });
    chip.primaryAxisAlignItems = "CENTER";
    chip.counterAxisAlignItems = "CENTER";
    chip.resize(38, 38);
    chip.layoutSizingHorizontal = "FIXED";
    chip.layoutSizingVertical = "FIXED";
    chip.fills = [];
    chip.strokeWeight = 1;
    stroke(chip, "line/border");
    radius(chip, "radius/md");
    chip.appendChild(ico("braces", 17, null, JSON_AMBER));
    card.appendChild(chip);

    const meta = AL("VERTICAL", { name: "Meta", itemSpacing: 1 });
    meta.fills = [];
    meta.appendChild(txt("aapl_1h.json", "Label/13 Medium", "text/foreground"));
    meta.appendChild(txt("JSON", "UI/12", "text/muted-foreground"));
    card.appendChild(meta);
    fillsHoriz(meta);
    card.appendChild(ico("external-link", 15, "text/muted-foreground"));

    body.appendChild(card);
    fillsHoriz(card);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Panel/Files
  // ═══════════════════════════════════════════════════════════════════
  const fileRowComp = (function () {
    const r = AL("HORIZONTAL", { name: "Files/Row", itemSpacing: 7 });
    r.counterAxisAlignItems = "CENTER";
    r.paddingLeft = 10;
    r.paddingRight = 10;
    r.resize(DOCK_W, 26);
    r.layoutSizingHorizontal = "FIXED";
    r.layoutSizingVertical = "FIXED";
    r.fills = [];
    // The disclosure arrow is always here and hidden on leaves — an instance
    // cannot be given a new child, so it cannot be added per-row.
    r.appendChild(ico("chevron-right", 12, "text/muted-foreground"));
    r.appendChild(ico("folder", 15, "text/muted-foreground"));
    r.appendChild(txt("name", "Body/13", "text/foreground"));
    const c = figma.createComponentFromNode(r);
    c.name = "Files/Row";
    c.description = "26px tree row: disclosure (hidden on leaves), type glyph, name.";
    return c;
  })();

  const files = panelShell("Panel/Files", [["Terminal", false], ["Artifacts", false], ["Files", true]]);
  {
    const head = AL("HORIZONTAL", { name: "Header", itemSpacing: 0 });
    head.counterAxisAlignItems = "CENTER";
    head.paddingLeft = 14;
    head.paddingRight = 12;
    head.fills = [];
    edges(head, 0, 0, 1, 0);
    stroke(head, "line/border");
    files.appendChild(head);
    fixThen(head, DOCK_W, 30, true, false);
    const h = txt("SANDBOX FILES", "UI/11 Medium", "text/muted-foreground");
    h.letterSpacing = { unit: "PERCENT", value: 5 };
    head.appendChild(h);
    fillsHoriz(h);
    head.appendChild(ico("refresh-cw", 14, "text/muted-foreground"));

    const search = AL("HORIZONTAL", { name: "Search", itemSpacing: 0 });
    search.counterAxisAlignItems = "CENTER";
    search.paddingLeft = 14;
    search.paddingRight = 12;
    search.fills = [];
    edges(search, 0, 0, 1, 0);
    stroke(search, "line/border");
    files.appendChild(search);
    fixThen(search, DOCK_W, 30, true, false);
    const ph = txt("Search files...", "Body/13", "text/muted-foreground");
    search.appendChild(ph);
    fillsHoriz(ph);
    search.appendChild(ico("eye", 15, "text/muted-foreground"));

    const tree = AL("VERTICAL", { name: "Tree", itemSpacing: 0 });
    tree.fills = [];
    tree.paddingTop = 4;
    files.appendChild(tree);
    fillsHoriz(tree);

    function treeRow(glyph, label, indent, hex, disclosure) {
      const i = fileRowComp.createInstance();
      i.name = label;
      i.paddingLeft = 10 + indent;
      i.children[0].visible = !!disclosure;
      const g = i.children[1];
      g.swapComponent(ICON[glyph]);
      g.resize(15, 15);
      g.fills = [];
      for (const n of g.findAll(() => true)) {
        if ("strokeWeight" in n && typeof n.strokeWeight === "number" && n.strokeWeight > 0) {
          n.strokeWeight = n.strokeWeight * (15 / 24);
        }
        if ("strokes" in n && Array.isArray(n.strokes) && n.strokes.length) {
          n.strokes = hex ? [solid(hex)] : [bound("text/muted-foreground")];
        }
        if ("fills" in n && Array.isArray(n.fills) && n.fills.length) {
          n.fills = hex ? [solid(hex)] : [bound("text/muted-foreground")];
        }
      }
      i.children[2].characters = label;
      tree.appendChild(i);
      fillsHoriz(i);
      return i;
    }

    treeRow("folder", ".tasks", 4, null, true);
    treeRow("python", "_run_1786591856549.py", 21, PY_BLUE, false);
    treeRow("python", "_run_1786591861678.py", 21, PY_BLUE, false);
    treeRow("python", "_run_1786591883366.py", 21, PY_BLUE, false);
    treeRow("braces", "aapl_1h.json", 21, JSON_AMBER, false);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Panel/Terminal
  // ═══════════════════════════════════════════════════════════════════
  const terminal = panelShell("Panel/Terminal", [["Terminal", true], ["Artifacts", false], ["Files", false]]);
  {
    const body = AL("VERTICAL", { name: "Shell", itemSpacing: 0 });
    fill(body, "surface/card");
    body.paddingLeft = 10;
    body.paddingTop = 9;
    body.paddingRight = 10;
    body.clipsContent = false;
    terminal.appendChild(body);
    fillsHoriz(body);
    body.layoutSizingVertical = "FILL";

    const line = AL("HORIZONTAL", { name: "Prompt", itemSpacing: 0 });
    line.counterAxisAlignItems = "CENTER";
    line.fills = [];
    line.appendChild(txt("root@78c118601275:/work# ", "Mono/13", "text/foreground"));
    const caret = figma.createRectangle();
    caret.resize(7, 15);
    fill(caret, "text/foreground");
    caret.opacity = 0.75;
    caret.strokes = [];
    line.appendChild(caret);
    body.appendChild(line);

    // The new-terminal button sits inside the terminal, top-right — right-2
    // top-2 in TerminalPanel.tsx, not in the dock title bar.
    const plus = AL("HORIZONTAL", { name: "New terminal" });
    plus.primaryAxisAlignItems = "CENTER";
    plus.counterAxisAlignItems = "CENTER";
    plus.resize(22, 22);
    plus.layoutSizingHorizontal = "FIXED";
    plus.layoutSizingVertical = "FIXED";
    plus.fills = [];
    plus.appendChild(ico("plus", 14, "text/muted-foreground"));
    body.appendChild(plus);
    plus.layoutPositioning = "ABSOLUTE";
    plus.x = DOCK_W - 30;
    plus.y = 8;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Panel/Tasks
  // ═══════════════════════════════════════════════════════════════════
  /**
   * The dev badge is a 12% brand wash on the surface behind it.
   *
   * Written as an opacity on a variable-bound paint it renders solid — the
   * Plugin API keeps the binding and throws the opacity away. So the wash gets
   * a name of its own instead, which is what it deserved anyway: one token,
   * one colour, changeable in the same place as the rest.
   */
  async function ensureColor(col, name, hex) {
    if (!col) return null;
    for (const id of col.variableIds) {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (v && v.name === name) return v;
    }
    const v = figma.variables.createVariable(name, col, "COLOR");
    v.scopes = ["FRAME_FILL", "SHAPE_FILL"];
    v.setValueForMode(col.modes[0].modeId, rgb(hex));
    return v;
  }
  {
    // The pill and the word inside it are both named "dev", so the type matters:
    // matching on the name alone hits the text and leaves the pill untouched.
    const pill = titlebarComp.findOne(function (n) { return n.name === "dev" && n.type === "FRAME"; });
    const word = titlebarComp.findOne(function (n) { return n.name === "dev" && n.type === "TEXT"; });
    if (pill && V["brand/wash"]) pill.fills = [bound("brand/wash")];
    if (word) word.fills = [bound("brand/brand")];
    notes.push("badge " + (pill && V["brand/wash"] ? "ok" : "?"));
  }

  const taskRowComp = (function () {
    const r = AL("HORIZONTAL", { name: "Tasks/Row", itemSpacing: 10 });
    r.counterAxisAlignItems = "CENTER";
    r.paddingLeft = 12;
    r.paddingRight = 10;
    r.paddingTop = 8;
    r.paddingBottom = 8;
    r.resize(DOCK_W - 24, 50);
    r.layoutSizingHorizontal = "FIXED";
    r.layoutSizingVertical = "FIXED";
    fill(r, "surface/card");
    r.strokeWeight = 1;
    stroke(r, "line/border");
    radius(r, "radius/lg");
    r.appendChild(ico("check", 15, "text/muted-foreground"));
    const meta = AL("VERTICAL", { name: "Meta", itemSpacing: 2 });
    meta.fills = [];
    meta.appendChild(txt("Task", "Body/13", "text/foreground"));
    meta.appendChild(txt("Completed  0.0s", "UI/11 Medium", "text/muted-foreground"));
    r.appendChild(meta);
    meta.layoutSizingHorizontal = "FILL";
    r.appendChild(ico("chevron-right", 14, "text/muted-foreground"));
    const c = figma.createComponentFromNode(r);
    c.name = "Tasks/Row";
    c.description = "50px task card: outcome glyph, command, state + duration, disclosure.";
    return c;
  })();

  const tasks = AL("VERTICAL", { name: "Panel/Tasks", itemSpacing: 0 });
  tasks.resize(DOCK_W, BODY_H - TOP_PANEL_H);
  tasks.layoutSizingHorizontal = "FIXED";
  tasks.layoutSizingVertical = "FIXED";
  fill(tasks, "surface/card");
  tasks.clipsContent = true;
  edges(tasks, 1, 0, 0, 1);
  stroke(tasks, "line/border");
  {
    const strip = dockStrip([["Tasks", true]]);
    tasks.appendChild(strip);
    fixThen(strip, DOCK_W, 32, true, false);

    const head = AL("HORIZONTAL", { name: "Header", itemSpacing: 5 });
    head.counterAxisAlignItems = "CENTER";
    head.paddingLeft = 14;
    head.paddingRight = 14;
    head.fills = [];
    tasks.appendChild(head);
    fixThen(head, DOCK_W, 32, true, false);
    head.appendChild(txt("Finished 9", "Body/13", "text/foreground"));
    head.appendChild(ico("chevron-down", 14, "text/muted-foreground"));
    spacer(head);
    head.appendChild(txt("Clear", "Body/13", "text/muted-foreground"));

    const list = AL("VERTICAL", { name: "Tasks", itemSpacing: 10 });
    list.fills = [];
    list.paddingLeft = 12;
    list.paddingRight = 12;
    list.paddingTop = 2;
    tasks.appendChild(list);
    fillsHoriz(list);

    const rows = [
      [true, 'Python · import json, yfinance as yf df = yf.Ticker("AAPL").history(…', "Completed  3.8s"],
      [true, "Command · pip install yfinance 2>&1 | tail -3", "Completed  10s"],
      [true, 'Command · cat .tasks/bg-1-msqynwxw.output; python3 -c "import yfinanc…', "Completed  1.1s"],
      [true, "Read · bg-1-msqynwxw.output", "Completed  0.0s"],
      [false, "Read · bg-1-msqynwxw.output", "Failed  0.0s"],
      [true, "TeamList", "Completed  0.0s"],
      [false, 'Python · import json, yfinance as yf df = yf.Ticker("AAPL").history(…', "Failed  1.1s"],
      [true, "Command · pip install yfinance 2>&1 | tail -2", "Completed  0.5s"],
    ];
    for (const [ok, title, state] of rows) {
      const i = taskRowComp.createInstance();
      i.name = title.slice(0, 30);
      const g = i.children[0];
      if (!ok) {
        g.swapComponent(ICON["x"]);
        g.resize(15, 15);
        g.fills = [];
        for (const n of g.findAll(() => true)) {
          if ("strokeWeight" in n && typeof n.strokeWeight === "number" && n.strokeWeight > 0) {
            n.strokeWeight = n.strokeWeight * (15 / 24);
          }
          if ("strokes" in n && Array.isArray(n.strokes) && n.strokes.length) n.strokes = [bound("status/red")];
        }
      }
      const meta = i.children[1];
      meta.children[0].characters = title;
      meta.children[1].characters = state;
      list.appendChild(i);
      fillsHoriz(i);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Chat column
  // ═══════════════════════════════════════════════════════════════════
  const PAD = 20;
  const CW = CHAT_W - PAD * 2;

  const chat = AL("VERTICAL", { name: "Chat column", itemSpacing: 0 });
  chat.resize(CHAT_W, BODY_H);
  chat.layoutSizingHorizontal = "FIXED";
  chat.layoutSizingVertical = "FIXED";
  fill(chat, "surface/card");
  chat.clipsContent = true;
  {
    // tab strip
    const strip = AL("HORIZONTAL", { name: "Tab strip", itemSpacing: 0 });
    fill(strip, "surface/muted");
    strip.counterAxisAlignItems = "CENTER";
    strip.paddingRight = 6;
    edges(strip, 0, 0, 1, 0);
    stroke(strip, "line/border");
    chat.appendChild(strip);
    fixThen(strip, CHAT_W, 32, true, false);

    const tab = AL("HORIZONTAL", { name: "Chat" });
    tab.primaryAxisAlignItems = "CENTER";
    tab.counterAxisAlignItems = "CENTER";
    tab.paddingLeft = 16;
    tab.paddingRight = 16;
    fill(tab, "surface/card");
    edges(tab, 0, 1, 0, 0);
    stroke(tab, "line/border");
    tab.appendChild(txt("Chat", "Body/13", "text/foreground"));
    strip.appendChild(tab);
    tab.layoutSizingVertical = "FILL";
    spacer(strip);
    const exp = AL("HORIZONTAL", { name: "Expand" });
    exp.primaryAxisAlignItems = "CENTER";
    exp.counterAxisAlignItems = "CENTER";
    exp.resize(26, 26);
    exp.layoutSizingHorizontal = "FIXED";
    exp.layoutSizingVertical = "FIXED";
    exp.fills = [];
    exp.appendChild(ico("maximize-2", 14, "text/muted-foreground"));
    strip.appendChild(exp);

    // conversation
    const conv = AL("VERTICAL", { name: "Conversation", itemSpacing: 11 });
    conv.fills = [];
    conv.paddingLeft = PAD;
    conv.paddingRight = PAD;
    conv.paddingTop = 18;
    conv.paddingBottom = 10;
    conv.clipsContent = true;
    chat.appendChild(conv);
    fillsHoriz(conv);
    conv.layoutSizingVertical = "FILL";

    const title = para("Нарисуй график Apple 1h month", "Body/13", "text/muted-foreground", CW);
    conv.appendChild(title);
    fillsHoriz(title);

    const userRow = AL("HORIZONTAL", { name: "User turn" });
    userRow.fills = [];
    userRow.primaryAxisAlignItems = "MAX";
    conv.appendChild(userRow);
    fillsHoriz(userRow);
    const bubble = AL("HORIZONTAL", { name: "Bubble" });
    bubble.paddingLeft = 14;
    bubble.paddingRight = 14;
    bubble.paddingTop = 8;
    bubble.paddingBottom = 8;
    fill(bubble, "surface/muted");
    radius(bubble, "radius/2xl");
    bubble.appendChild(txt("Нарисуй график Apple 1h month", "Body/15", "text/foreground"));
    userRow.appendChild(bubble);

    function toolRow(label) {
      const r = AL("HORIZONTAL", { name: label, itemSpacing: 5 });
      r.counterAxisAlignItems = "CENTER";
      r.fills = [];
      r.appendChild(txt(label, "Body/13", "text/muted-foreground"));
      r.appendChild(ico("chevron-right", 13, "text/muted-foreground"));
      return r;
    }
    const flow = [
      ["t", "Used 3 tools"],
      ["p", "Установка yfinance ещё идёт в фоне. Подожду завершения."],
      ["t", "Used 4 tools"],
      ["p", "Установка в фоне не завершилась. Поставлю в обычном режиме."],
      ["t", "Used 2 tools"],
      ["p", "Данные получены: 161 часовая свеча за последний месяц, последнее закрытие $302.23. Рисую свечной график."],
    ];
    for (const [kind, s] of flow) {
      if (kind === "t") conv.appendChild(toolRow(s));
      else {
        const p = para(s, "Body/15", "text/foreground", CW);
        conv.appendChild(p);
        fillsHoriz(p);
      }
    }

    // ── the AAPL card ────────────────────────────────────────────────
    const card = AL("VERTICAL", { name: "AAPL chart", itemSpacing: 0 });
    card.fills = [];
    card.strokeWeight = 1;
    stroke(card, "line/border");
    radius(card, "radius/lg");
    card.clipsContent = true;
    conv.appendChild(card);
    fillsHoriz(card);

    const cHead = AL("VERTICAL", { name: "Header", itemSpacing: 3 });
    cHead.fills = [];
    cHead.paddingLeft = 12;
    cHead.paddingRight = 12;
    cHead.paddingTop = 10;
    cHead.paddingBottom = 9;
    card.appendChild(cHead);
    fillsHoriz(cHead);

    const idRow = AL("HORIZONTAL", { name: "Instrument", itemSpacing: 7 });
    idRow.counterAxisAlignItems = "CENTER";
    idRow.fills = [];
    cHead.appendChild(idRow);
    fillsHoriz(idRow);
    const ticker = figma.createText();
    ticker.fontName = { family: "Inter", style: "Semi Bold" };
    ticker.characters = "AAPL";
    ticker.fontSize = 13;
    ticker.fills = [bound("text/foreground")];
    idRow.appendChild(ticker);
    for (const s of ["Apple Inc.", "USD", "2026-08-12 15:30"]) {
      idRow.appendChild(txt(s, "UI/12", "text/muted-foreground"));
    }
    spacer(idRow);
    const stats = AL("HORIZONTAL", { name: "Stats", itemSpacing: 16 });
    stats.fills = [];
    for (const [label, value] of [["Open", "301.67"], ["Close", "302.23"], ["High", "302.25"], ["Low", "301.00"], ["Volume", "5.5M"]]) {
      const cell = AL("VERTICAL", { name: label, itemSpacing: 1 });
      cell.fills = [];
      cell.counterAxisAlignItems = "MAX";
      const l = txt(label, "UI/10 Medium", "text/muted-foreground");
      const v = txt(value, "Body/13", "text/foreground");
      l.textAlignHorizontal = "RIGHT";
      v.textAlignHorizontal = "RIGHT";
      cell.appendChild(l);
      cell.appendChild(v);
      stats.appendChild(cell);
    }
    idRow.appendChild(stats);

    const priceRow = AL("HORIZONTAL", { name: "Price", itemSpacing: 8 });
    priceRow.counterAxisAlignItems = "BASELINE";
    priceRow.fills = [];
    priceRow.appendChild(bigTxt("302.23", 21, "Semi Bold", CHART_UP));
    priceRow.appendChild(txt("+0.55(+0.18%)", "UI/12", null, CHART_UP));
    cHead.appendChild(priceRow);
    cHead.appendChild(txt("1 месяц, часовые свечи", "UI/11 Medium", "text/muted-foreground"));

    const rule = figma.createRectangle();
    rule.resize(CW, 1);
    rule.strokes = [];
    fill(rule, "line/border");
    card.appendChild(rule);
    rule.layoutSizingHorizontal = "FILL";

    // plot ------------------------------------------------------------
    const PLOT_W = CW - 24;
    const AXIS_W = 30;
    const CHART_W2 = PLOT_W - AXIS_W;
    const CHART_H = 190;

    const plot = box(PLOT_W, CHART_H + 22);
    plot.name = "Plot";
    plot.clipsContent = false;
    const plotWrap = AL("VERTICAL", { name: "Plot area" });
    plotWrap.fills = [];
    plotWrap.paddingLeft = 12;
    plotWrap.paddingRight = 12;
    plotWrap.paddingTop = 12;
    plotWrap.paddingBottom = 8;
    card.appendChild(plotWrap);
    fillsHoriz(plotWrap);
    plotWrap.appendChild(plot);

    const PMIN = 296, PMAX = 345;
    const yFor = (p) => ((PMAX - p) / (PMAX - PMIN)) * CHART_H;

    for (const p of [340, 330, 320, 310, 300]) {
      const lab = txt(String(p), "UI/10 Medium", "text/muted-foreground");
      lab.textAlignHorizontal = "RIGHT";
      lab.resize(AXIS_W - 8, lab.height);
      plot.appendChild(lab);
      lab.x = 0;
      lab.y = yFor(p) - 7;
    }

    // A deterministic walk shaped like the real month: a climb into the
    // start of August, the gap, then the slide back to 301.
    const CTRL = [
      [0, 313], [0.04, 311], [0.1, 316], [0.15, 322], [0.19, 318], [0.24, 321],
      [0.3, 327], [0.34, 324], [0.38, 326], [0.43, 330], [0.47, 328], [0.52, 332],
      [0.57, 337], [0.6, 341], [0.63, 338], [0.66, 340], [0.69, 335], [0.72, 331],
      [0.745, 333], [0.75, 309], [0.79, 311], [0.83, 314], [0.86, 312], [0.9, 308],
      [0.94, 304], [0.97, 302], [1, 301],
    ];
    function baseline(t) {
      for (let i = 1; i < CTRL.length; i++) {
        if (t <= CTRL[i][0]) {
          const [t0v, p0] = CTRL[i - 1];
          const [t1v, p1] = CTRL[i];
          const k = (t - t0v) / (t1v - t0v || 1);
          return p0 + (p1 - p0) * k;
        }
      }
      return CTRL[CTRL.length - 1][1];
    }
    let seed = 20260812;
    function rnd() {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    }

    const N = 161;
    const pitch = CHART_W2 / N;
    const bodyW = Math.max(1.4, pitch * 0.62);
    let svg = '<svg width="' + CHART_W2 + '" height="' + CHART_H + '" viewBox="0 0 ' + CHART_W2 + " " + CHART_H +
      '" fill="none" xmlns="http://www.w3.org/2000/svg">';
    for (const p of [340, 330, 320, 310, 300]) {
      const y = yFor(p);
      svg += '<path d="M0 ' + y.toFixed(1) + "H" + CHART_W2.toFixed(1) + '" stroke="#EEF0F2" stroke-width="1"/>';
    }
    // Where the series jumps, the market was shut — the app draws nothing
    // there, so neither does this. One tall candle bridging the hole would
    // read as a crash inside a single hour.
    let gapEnd = -1;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const prev = baseline(Math.max(0, (i - 1) / (N - 1)));
      const cur = baseline(t);
      if (Math.abs(cur - prev) > 5) gapEnd = i + 3;
      if (i < gapEnd) continue;
      const o = prev + (rnd() - 0.5) * 1.6;
      const c = cur + (rnd() - 0.5) * 1.6;
      const hi = Math.max(o, c) + rnd() * 1.5;
      const lo = Math.min(o, c) - rnd() * 1.5;
      const up = c >= o;
      const col = up ? CHART_UP : CHART_DOWN;
      const x = i * pitch + pitch / 2;
      svg += '<path d="M' + x.toFixed(2) + " " + yFor(hi).toFixed(2) + "V" + yFor(lo).toFixed(2) +
        '" stroke="' + col + '" stroke-width="1"/>';
      const yTop = yFor(Math.max(o, c));
      const h = Math.max(1, Math.abs(yFor(o) - yFor(c)));
      svg += '<rect x="' + (x - bodyW / 2).toFixed(2) + '" y="' + yTop.toFixed(2) +
        '" width="' + bodyW.toFixed(2) + '" height="' + h.toFixed(2) + '" fill="' + col + '"/>';
    }
    svg += "</svg>";
    const chartNode = figma.createNodeFromSvg(svg);
    chartNode.name = "Candles";
    plot.appendChild(chartNode);
    chartNode.x = AXIS_W;
    chartNode.y = 0;

    const xLabels = ["07/13 09:30", "07/16 09:30", "07/21 09:30", "07/24 09:30", "07/29 09:30", "08/03 09:30", "08/06 09:30", "08/11 09:30"];
    xLabels.forEach((s, i) => {
      const l = txt(s, "UI/10 Medium", "text/muted-foreground");
      l.textAlignHorizontal = "CENTER";
      l.resize(64, l.height);
      plot.appendChild(l);
      l.x = AXIS_W + (CHART_W2 / xLabels.length) * (i + 0.5) - 32;
      l.y = CHART_H + 7;
    });

    // ── closing paragraph + artifact card ────────────────────────────
    const tail = para(
      "Данные — в aapl_1h.json (labels + OHLC + volume), 161 свеча с 13 июля по 12 августа.",
      "Body/15", "text/foreground", CW);
    conv.appendChild(tail);
    fillsHoriz(tail);
    const mono = tail.characters.indexOf("aapl_1h.json");
    tail.setRangeFontName(mono, mono + 12, { family: "Cascadia Code", style: "Regular" });
    tail.setRangeFontSize(mono, mono + 12, 13.5);

    const art = AL("HORIZONTAL", { name: "Artifact card", itemSpacing: 12 });
    art.counterAxisAlignItems = "CENTER";
    art.paddingLeft = 12;
    art.paddingRight = 12;
    art.paddingTop = 10;
    art.paddingBottom = 10;
    art.fills = [];
    art.strokeWeight = 1;
    stroke(art, "line/border");
    radius(art, "radius/lg");
    const chip2 = AL("HORIZONTAL", { name: "Type" });
    chip2.primaryAxisAlignItems = "CENTER";
    chip2.counterAxisAlignItems = "CENTER";
    chip2.resize(38, 38);
    chip2.layoutSizingHorizontal = "FIXED";
    chip2.layoutSizingVertical = "FIXED";
    chip2.fills = [];
    chip2.strokeWeight = 1;
    stroke(chip2, "line/border");
    radius(chip2, "radius/md");
    chip2.appendChild(ico("braces", 17, null, JSON_AMBER));
    art.appendChild(chip2);
    const meta2 = AL("VERTICAL", { name: "Meta", itemSpacing: 1 });
    meta2.fills = [];
    meta2.appendChild(txt("aapl_1h.json", "Label/13 Medium", "text/foreground"));
    meta2.appendChild(txt("JSON", "UI/12", "text/muted-foreground"));
    art.appendChild(meta2);
    fillsHoriz(meta2);
    const openBtn = AL("HORIZONTAL", { name: "Open" });
    openBtn.primaryAxisAlignItems = "CENTER";
    openBtn.counterAxisAlignItems = "CENTER";
    openBtn.paddingLeft = 14;
    openBtn.paddingRight = 14;
    openBtn.paddingTop = 6;
    openBtn.paddingBottom = 6;
    fill(openBtn, "surface/muted");
    radius(openBtn, "radius/md");
    openBtn.appendChild(txt("Open", "Label/13 Medium", "text/foreground"));
    art.appendChild(openBtn);
    conv.appendChild(art);
    fillsHoriz(art);

    // ── composer ─────────────────────────────────────────────────────
    const holder = AL("VERTICAL", { name: "Composer holder" });
    holder.fills = [];
    holder.paddingLeft = PAD;
    holder.paddingRight = PAD;
    holder.paddingBottom = 14;
    chat.appendChild(holder);
    fillsHoriz(holder);

    const comp = AL("VERTICAL", { name: "Composer", itemSpacing: 12 });
    comp.fills = [];
    comp.paddingLeft = 14;
    comp.paddingRight = 10;
    comp.paddingTop = 12;
    comp.paddingBottom = 10;
    comp.strokeWeight = 1;
    stroke(comp, "line/border");
    radius(comp, "radius/2xl");
    holder.appendChild(comp);
    fillsHoriz(comp);

    const row1 = AL("HORIZONTAL", { name: "Input" });
    row1.counterAxisAlignItems = "CENTER";
    row1.fills = [];
    comp.appendChild(row1);
    fillsHoriz(row1);
    const ph2 = txt("Type / for commands", "Body/15", "text/muted-foreground");
    row1.appendChild(ph2);
    fillsHoriz(ph2);
    const send = AL("HORIZONTAL", { name: "Send" });
    send.primaryAxisAlignItems = "CENTER";
    send.counterAxisAlignItems = "CENTER";
    send.resize(28, 28);
    send.layoutSizingHorizontal = "FIXED";
    send.layoutSizingVertical = "FIXED";
    fill(send, "surface/muted");
    radius(send, "radius/md");
    send.appendChild(ico("arrow-up", 15, "text/muted-foreground"));
    row1.appendChild(send);

    const row2 = AL("HORIZONTAL", { name: "Controls", itemSpacing: 14 });
    row2.counterAxisAlignItems = "CENTER";
    row2.fills = [];
    comp.appendChild(row2);
    fillsHoriz(row2);
    row2.appendChild(ico("plus", 16, "text/muted-foreground"));
    const skip = AL("HORIZONTAL", { name: "Skip all approvals", itemSpacing: 5 });
    skip.counterAxisAlignItems = "CENTER";
    skip.fills = [];
    skip.appendChild(ico("triangle-alert", 14, "status/destructive"));
    skip.appendChild(txt("Skip all approvals", "Body/13", "status/destructive"));
    skip.appendChild(ico("chevron-down", 12, "status/destructive"));
    row2.appendChild(skip);
    row2.appendChild(ico("mic", 16, "text/muted-foreground"));
    row2.appendChild(ico("audio-lines", 16, "text/muted-foreground"));
    spacer(row2);
    const usage = AL("HORIZONTAL", { name: "Usage", itemSpacing: 5 });
    usage.counterAxisAlignItems = "CENTER";
    usage.fills = [];
    usage.appendChild(ico("gauge", 14, "text/muted-foreground"));
    usage.appendChild(txt("20.0k · 2%", "Body/13", "text/muted-foreground"));
    row2.appendChild(usage);
    const max = AL("HORIZONTAL", { name: "Max", itemSpacing: 5 });
    max.counterAxisAlignItems = "CENTER";
    max.fills = [];
    max.appendChild(ico("sparkles", 14, null, MAX_PINK));
    max.appendChild(txt("Max", "Label/13 Medium", null, MAX_PINK));
    row2.appendChild(max);
    row2.appendChild(txt("DeepSeek V4 Flash", "Body/13", "text/muted-foreground"));
  }

  const chatComp = figma.createComponentFromNode(chat);
  chatComp.name = "Chat column";
  chatComp.description = "The conversation surface: tab strip, turns, the chart card the model produced, and the composer.";

  const artifactsComp = figma.createComponentFromNode(artifacts);
  artifactsComp.name = "Panel/Artifacts";
  const filesComp = figma.createComponentFromNode(files);
  filesComp.name = "Panel/Files";
  const terminalComp = figma.createComponentFromNode(terminal);
  terminalComp.name = "Panel/Terminal";
  const tasksComp = figma.createComponentFromNode(tasks);
  tasksComp.name = "Panel/Tasks";

  // Park every component on a shelf to the left of the screens, so the canvas
  // reads as "parts here, screens there" instead of a pile.
  const btnComp = page.findOne(function (n) { return n.type === "COMPONENT" && n.name === "Header/Icon button"; });
  const recentComp = page.findOne(function (n) { return n.type === "COMPONENT" && n.name === "Sidebar/Recent item"; });
  const shelf = [
    [titlebarComp, -2200, 0],
    [sidebarComp, -2200, 60],
    [chatComp, -1840, 60],
    [artifactsComp, -1040, 60],
    [filesComp, -1040, 680],
    [terminalComp, -1040, 1300],
    [tasksComp, -1040, 1920],
    [iconsSection, -2200, 1250],
    [btnComp, -2200, 1780],
    [recentComp, -2150, 1780],
    [fileRowComp, -1750, 1780],
    [taskRowComp, -1750, 1830],
  ];
  for (const [n, x, y] of shelf) {
    if (!n) continue;
    page.appendChild(n);
    n.x = x;
    n.y = y;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Screens
  // ═══════════════════════════════════════════════════════════════════
  function screen(name, x, topPanel) {
    const f = AL("VERTICAL", { name: name, itemSpacing: 0 });
    f.resize(SCREEN_W, SCREEN_H);
    f.layoutSizingHorizontal = "FIXED";
    f.layoutSizingVertical = "FIXED";
    fill(f, "surface/background");
    f.clipsContent = true;
    page.appendChild(f);
    f.x = x;
    f.y = 0;

    const tb = titlebarComp.createInstance();
    f.appendChild(tb);
    tb.layoutSizingHorizontal = "FILL";

    const bodyRow = AL("HORIZONTAL", { name: "Body", itemSpacing: 0 });
    bodyRow.fills = [];
    f.appendChild(bodyRow);
    bodyRow.layoutSizingHorizontal = "FILL";
    bodyRow.layoutSizingVertical = "FILL";

    const sb = sidebarComp.createInstance();
    bodyRow.appendChild(sb);
    sb.layoutSizingVertical = "FILL";

    const ch = chatComp.createInstance();
    bodyRow.appendChild(ch);
    ch.layoutSizingHorizontal = "FILL";
    ch.layoutSizingVertical = "FILL";

    const dock = AL("VERTICAL", { name: "Dock", itemSpacing: 0 });
    dock.fills = [];
    dock.resize(DOCK_W, BODY_H);
    dock.layoutSizingHorizontal = "FIXED";
    bodyRow.appendChild(dock);
    dock.layoutSizingVertical = "FILL";

    const tp = topPanel.createInstance();
    dock.appendChild(tp);
    tp.layoutSizingHorizontal = "FILL";

    const tk = tasksComp.createInstance();
    dock.appendChild(tk);
    tk.layoutSizingHorizontal = "FILL";
    tk.layoutSizingVertical = "FILL";
    return f;
  }

  const s1 = screen("1 · Chat + Artifacts", 0, artifactsComp);
  const s2 = screen("2 · Chat + Files", SCREEN_W + 120, filesComp);
  const s3 = screen("3 · Chat + Terminal", (SCREEN_W + 120) * 2, terminalComp);

  await Promise.all(pending);
  figma.currentPage.selection = [s1];
  figma.viewport.scrollAndZoomIntoView([s1, s2, s3]);

  figma.closePlugin(
    "Собрано 3 экрана за " + ((Date.now() - t0) / 1000).toFixed(1) + "s · " + notes.join(" · "),
  );
}

// Without this, a throw inside the async body leaves the plugin "Running…"
// for ever and says nothing — which is exactly how the first run failed.
build().catch(function (e) {
  console.error(e);
  const where = e && e.stack ? " @ " + e.stack.split("\n")[1] : "";
  figma.closePlugin("Ошибка: " + (e && e.message ? e.message : String(e)) + where);
});
