/**
 * Code highlighting themes — one palette, three surfaces.
 *
 * Every place the app colours code reads the SAME ten CSS variables:
 * the chat's code blocks and diffs (`.diff-hl .token.*` in globals.css),
 * the notebook viewer (same class), and Monaco (CodeEditor reads the
 * variables when defining its theme). So a theme here is just ten hex
 * values per mode, and applying one is writing variables — everything on
 * screen recolours instantly, no re-render, no reload.
 *
 * Light and dark are chosen SEPARATELY, like VS Code does it: most classic
 * palettes exist in one mode only, and Dracula on a white panel is not a
 * theme, it is an accident. The app's light/dark toggle then picks which
 * of the two chosen palettes is live.
 *
 * The defaults reproduce exactly what globals.css shipped before themes
 * existed: One Light and VS Code Dark+.
 */

export interface CodePalette {
  id: string;
  label: string;
  mode: "light" | "dark";
  /** The ten slots, keyed by CSS variable suffix. */
  colors: {
    comment: string;
    punct: string;
    const: string;
    class: string;
    keyword: string;
    tag: string;
    string: string;
    func: string;
    var: string;
    op: string;
  };
}

export const CODE_THEMES: CodePalette[] = [
  // ── Light ──────────────────────────────────────────────────────────────
  {
    id: "one-light",
    label: "One Light",
    mode: "light",
    // The app's original light palette, verbatim — including its two merges
    // (class-name with constants, variable with function).
    colors: {
      comment: "#a0a1a7", punct: "#383a42", const: "#b76b01", class: "#b76b01",
      keyword: "#a626a4", tag: "#e45649", string: "#50a14f", func: "#4078f2",
      var: "#4078f2", op: "#0184bc",
    },
  },
  {
    id: "github-light",
    label: "GitHub Light",
    mode: "light",
    colors: {
      comment: "#6e7781", punct: "#24292f", const: "#0550ae", class: "#953800",
      keyword: "#cf222e", tag: "#116329", string: "#0a3069", func: "#8250df",
      var: "#24292f", op: "#cf222e",
    },
  },
  {
    id: "vs-light",
    label: "VS Code Light+",
    mode: "light",
    colors: {
      comment: "#008000", punct: "#000000", const: "#098658", class: "#267f99",
      keyword: "#af00db", tag: "#800000", string: "#a31515", func: "#795e26",
      var: "#001080", op: "#000000",
    },
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    mode: "light",
    colors: {
      comment: "#93a1a1", punct: "#657b83", const: "#cb4b16", class: "#b58900",
      keyword: "#859900", tag: "#268bd2", string: "#2aa198", func: "#268bd2",
      var: "#657b83", op: "#859900",
    },
  },
  {
    id: "gruvbox-light",
    label: "Gruvbox Light",
    mode: "light",
    colors: {
      comment: "#928374", punct: "#3c3836", const: "#8f3f71", class: "#b57614",
      keyword: "#9d0006", tag: "#9d0006", string: "#79740e", func: "#b57614",
      var: "#076678", op: "#af3a03",
    },
  },
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    mode: "light",
    colors: {
      comment: "#9ca0b0", punct: "#4c4f69", const: "#fe640b", class: "#df8e1d",
      keyword: "#8839ef", tag: "#d20f39", string: "#40a02b", func: "#1e66f5",
      var: "#4c4f69", op: "#04a5e5",
    },
  },
  {
    id: "tomorrow",
    label: "Tomorrow",
    mode: "light",
    colors: {
      comment: "#8e908c", punct: "#4d4d4c", const: "#f5871f", class: "#eab700",
      keyword: "#8959a8", tag: "#c82829", string: "#718c00", func: "#4271ae",
      var: "#c82829", op: "#3e999f",
    },
  },
  {
    id: "ayu-light",
    label: "Ayu Light",
    mode: "light",
    colors: {
      comment: "#abb0b6", punct: "#5c6166", const: "#a37acc", class: "#399ee6",
      keyword: "#fa8d3e", tag: "#55b4d4", string: "#86b300", func: "#f2ae49",
      var: "#5c6166", op: "#ed9366",
    },
  },
  {
    id: "rose-pine-dawn",
    label: "Rosé Pine Dawn",
    mode: "light",
    colors: {
      comment: "#9893a5", punct: "#575279", const: "#d7827e", class: "#ea9d34",
      keyword: "#286983", tag: "#b4637a", string: "#56949f", func: "#907aa9",
      var: "#575279", op: "#286983",
    },
  },
  {
    id: "quiet-light",
    label: "Quiet Light",
    mode: "light",
    colors: {
      comment: "#aaaaaa", punct: "#333333", const: "#ab6526", class: "#7a3e9d",
      keyword: "#4b69c6", tag: "#4b69c6", string: "#448c27", func: "#aa3731",
      var: "#7a3e9d", op: "#777777",
    },
  },
  // ── Dark ───────────────────────────────────────────────────────────────
  {
    id: "vs-dark",
    label: "VS Code Dark+",
    mode: "dark",
    // The app's original dark palette, verbatim.
    colors: {
      comment: "#6a9955", punct: "#d4d4d4", const: "#b5cea8", class: "#4ec9b0",
      keyword: "#c586c0", tag: "#569cd6", string: "#ce9178", func: "#dcdcaa",
      var: "#9cdcfe", op: "#d4d4d4",
    },
  },
  {
    id: "one-dark",
    label: "One Dark",
    mode: "dark",
    colors: {
      comment: "#5c6370", punct: "#abb2bf", const: "#d19a66", class: "#e5c07b",
      keyword: "#c678dd", tag: "#e06c75", string: "#98c379", func: "#61afef",
      var: "#e06c75", op: "#56b6c2",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    mode: "dark",
    colors: {
      comment: "#6272a4", punct: "#f8f8f2", const: "#bd93f9", class: "#8be9fd",
      keyword: "#ff79c6", tag: "#ff79c6", string: "#f1fa8c", func: "#50fa7b",
      var: "#f8f8f2", op: "#ff79c6",
    },
  },
  {
    id: "monokai",
    label: "Monokai",
    mode: "dark",
    colors: {
      comment: "#75715e", punct: "#f8f8f2", const: "#ae81ff", class: "#a6e22e",
      keyword: "#f92672", tag: "#f92672", string: "#e6db74", func: "#a6e22e",
      var: "#f8f8f2", op: "#f92672",
    },
  },
  {
    id: "nord",
    label: "Nord",
    mode: "dark",
    colors: {
      comment: "#616e88", punct: "#d8dee9", const: "#b48ead", class: "#8fbcbb",
      keyword: "#81a1c1", tag: "#81a1c1", string: "#a3be8c", func: "#88c0d0",
      var: "#d8dee9", op: "#81a1c1",
    },
  },
  {
    id: "gruvbox-dark",
    label: "Gruvbox Dark",
    mode: "dark",
    colors: {
      comment: "#928374", punct: "#ebdbb2", const: "#d3869b", class: "#8ec07c",
      keyword: "#fb4934", tag: "#83a598", string: "#b8bb26", func: "#fabd2f",
      var: "#83a598", op: "#fe8019",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    mode: "dark",
    colors: {
      comment: "#586e75", punct: "#839496", const: "#cb4b16", class: "#b58900",
      keyword: "#859900", tag: "#268bd2", string: "#2aa198", func: "#268bd2",
      var: "#839496", op: "#859900",
    },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    mode: "dark",
    colors: {
      comment: "#565f89", punct: "#a9b1d6", const: "#ff9e64", class: "#2ac3de",
      keyword: "#bb9af7", tag: "#f7768e", string: "#9ece6a", func: "#7aa2f7",
      var: "#c0caf5", op: "#89ddff",
    },
  },
  {
    id: "night-owl",
    label: "Night Owl",
    mode: "dark",
    colors: {
      comment: "#637777", punct: "#d6deeb", const: "#f78c6c", class: "#ffcb8b",
      keyword: "#c792ea", tag: "#7fdbca", string: "#ecc48d", func: "#82aaff",
      var: "#d6deeb", op: "#c792ea",
    },
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    mode: "dark",
    colors: {
      comment: "#6c7086", punct: "#cdd6f4", const: "#fab387", class: "#f9e2af",
      keyword: "#cba6f7", tag: "#f38ba8", string: "#a6e3a1", func: "#89b4fa",
      var: "#cdd6f4", op: "#89dceb",
    },
  },
  {
    id: "github-dark",
    label: "GitHub Dark",
    mode: "dark",
    colors: {
      comment: "#8b949e", punct: "#c9d1d9", const: "#79c0ff", class: "#ffa657",
      keyword: "#ff7b72", tag: "#7ee787", string: "#a5d6ff", func: "#d2a8ff",
      var: "#c9d1d9", op: "#ff7b72",
    },
  },
  {
    id: "synthwave-84",
    label: "SynthWave '84",
    mode: "dark",
    colors: {
      comment: "#848bbd", punct: "#ffffff", const: "#f97e72", class: "#fe4450",
      keyword: "#fede5d", tag: "#72f1b8", string: "#ff8b39", func: "#36f9f6",
      var: "#ff7edb", op: "#fede5d",
    },
  },
];

export const DEFAULT_LIGHT = "one-light";
export const DEFAULT_DARK = "vs-dark";

const KEY_LIGHT = "monet-code-theme-light";
const KEY_DARK = "monet-code-theme-dark";

/** Fired on window whenever the palette changes, so Monaco can re-theme. */
export const CODE_THEME_EVENT = "monet-code-theme";

export function themesFor(mode: "light" | "dark"): CodePalette[] {
  return CODE_THEMES.filter((t) => t.mode === mode);
}

export function currentThemeId(mode: "light" | "dark"): string {
  const stored = localStorage.getItem(mode === "light" ? KEY_LIGHT : KEY_DARK);
  const fallback = mode === "light" ? DEFAULT_LIGHT : DEFAULT_DARK;
  return CODE_THEMES.some((t) => t.id === stored && t.mode === mode)
    ? (stored as string)
    : fallback;
}

function varsBlock(p: CodePalette): string {
  return Object.entries(p.colors)
    .map(([slot, color]) => `--code-${slot}: ${color};`)
    .join(" ");
}

/**
 * Write both chosen palettes into one injected <style>. `:root` carries the
 * light values, `.dark` overrides them — the same shape the app's own theme
 * variables use, so the mode toggle switches code colours for free.
 */
export function applyCodeThemes(): void {
  const light = CODE_THEMES.find((t) => t.id === currentThemeId("light"))!;
  const dark = CODE_THEMES.find((t) => t.id === currentThemeId("dark"))!;
  const css = `:root { ${varsBlock(light)} }\n.dark { ${varsBlock(dark)} }`;
  let el = document.getElementById("code-theme") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "code-theme";
    document.head.appendChild(el);
  }
  el.textContent = css;
  window.dispatchEvent(new Event(CODE_THEME_EVENT));
}

export function setCodeTheme(mode: "light" | "dark", id: string): void {
  localStorage.setItem(mode === "light" ? KEY_LIGHT : KEY_DARK, id);
  applyCodeThemes();
}
