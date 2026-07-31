/**
 * What a clicked element looks like to the model.
 *
 * Pointing at a button is only useful if the model can find that button in the
 * source. So a selection carries two complementary signals, the same two
 * Cursor's design mode sends: an IDENTIFICATION (xpath, selector, component
 * name, props, the styles that were actually applied) and a PICTURE (a crop,
 * added by the caller) for spatial context.
 *
 * The third signal is ours: `searchTermsFor` yields what to grep the workspace
 * for, so the message can name candidate files outright. Component names from
 * a fibre are frequently minified or generic; the visible text almost never
 * is, and a distinctive class name sits in between. Ordering them is most of
 * the value here.
 *
 * Dependency-free: the formatting is what the model reads, so it is worth
 * asserting directly.
 */

export interface ElementRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RawElement {
  xpath: string;
  selector: string;
  tag: string;
  id?: string;
  classes?: string[];
  attrs?: Record<string, string>;
  text?: string;
  /** Viewport-relative, CSS pixels. */
  rect: ElementRect;
  /** Document-relative — what a screenshot clip needs. */
  pageRect?: ElementRect;
  styles?: Record<string, string>;
  framework?: string;
  component?: string;
  props?: Record<string, unknown>;
  /** file:line, when a dev-tools plugin left it in the DOM. */
  source?: string;
  parent?: string;
  siblingCount?: number;
}

export interface SelectionPayload {
  url: string;
  title: string;
  viewport: { w: number; h: number; dpr: number };
  elements: RawElement[];
  /** Shift-drag region, document-relative. */
  region?: ElementRect;
}

/** Class names that describe styling, not identity — useless for a grep. */
const UTILITY = new RegExp(
  "^(" +
    [
      "flex", "grid", "block", "inline", "inline-block", "hidden", "contents",
      "absolute", "relative", "fixed", "sticky", "static",
      "container", "group", "peer", "sr-only", "truncate", "antialiased",
      // Tailwind-shaped: a prefix, a dash, then a scale or colour.
      "[a-z]{1,3}-\\[?[\\d.]+", "[pm][xytrbl]?-", "space-[xy]-", "gap-",
      "text-", "bg-", "border", "rounded", "shadow", "opacity-", "ring-",
      "w-", "h-", "min-", "max-", "size-", "leading-", "tracking-", "font-",
      "items-", "justify-", "self-", "content-", "place-", "order-",
      "overflow-", "z-", "cursor-", "select-", "pointer-events-",
      "transition", "duration-", "ease-", "animate-", "transform", "scale-",
      "translate-", "rotate-", "hover:", "focus:", "active:", "disabled:",
      "dark:", "sm:", "md:", "lg:", "xl:", "2xl:",
    ].join("|") +
    ")",
);

const isUtility = (cls: string): boolean => UTILITY.test(cls);

/**
 * A short human name for the element.
 *
 * This becomes a token the user types around — ⟨SaveButton⟩ — so it carries no
 * angle brackets of its own. The block below still writes `component: <X>`,
 * which is where the renderer reads the name back from.
 */
export function summarizeElement(el: RawElement): string {
  if (el.component) return el.component;
  const cls = (el.classes ?? []).find((c) => !isUtility(c));
  const text = (el.text ?? "").trim().replace(/\s+/g, " ");
  if (cls) return `${el.tag}.${cls}`;
  if (text) return `${el.tag} "${text.slice(0, 24)}${text.length > 24 ? "…" : ""}"`;
  return el.id ? `${el.tag}#${el.id}` : el.tag;
}

/**
 * What to search the workspace for, best bet first.
 *
 * Visible text beats a component name: a build can rename `SaveButton` to `t`,
 * but "Save changes" is in the source exactly as it is on screen. A non-utility
 * class comes last — it is stable, but often shared by a dozen elements.
 */
export function searchTermsFor(el: RawElement): string[] {
  const terms: string[] = [];

  const text = (el.text ?? "").trim().replace(/\s+/g, " ");
  // Long enough to be distinctive, short enough to survive line wrapping in
  // the source. Whole words only — a cut-off word matches nothing.
  if (text.length >= 3 && text.length <= 60 && !/^\d+$/.test(text))
    terms.push(text);

  if (el.component && /^[A-Z][A-Za-z0-9_]{2,}$/.test(el.component))
    terms.push(el.component);

  if (el.id && el.id.length >= 3 && !/^[0-9:]+$/.test(el.id)) terms.push(el.id);

  const cls = (el.classes ?? []).filter((c) => !isUtility(c) && c.length >= 4);
  if (cls[0]) terms.push(cls[0]);

  // Deduplicate while keeping the order — the caller searches in this sequence
  // and stops when it has enough.
  return [...new Set(terms)];
}

const trunc = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}…` : s;

/** Props, flattened to one readable line and capped. */
function formatProps(props: Record<string, unknown> | undefined): string {
  if (!props) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    if (k === "children") continue;
    let text: string;
    if (v === null) text = "null";
    else if (typeof v === "function") text = "fn";
    else if (typeof v === "string") text = JSON.stringify(trunc(v, 60));
    else if (typeof v === "object") {
      try {
        text = trunc(JSON.stringify(v), 60);
      } catch {
        text = "{…}";
      }
    } else text = String(v);
    parts.push(`${k}=${text}`);
    if (parts.join(", ").length > 300) break;
  }
  return parts.join(", ");
}

function formatStyles(styles: Record<string, string> | undefined): string {
  if (!styles) return "";
  return Object.entries(styles)
    .filter(([, v]) => v && v !== "none" && v !== "normal" && v !== "auto")
    .map(([k, v]) => `${k}: ${trunc(v, 60)}`)
    .join("; ");
}

/** One element, as the block that goes into the message. */
export function formatElement(
  el: RawElement,
  index: number,
  candidates: string[] = [],
): string {
  const lines: string[] = [];
  const name = [
    el.tag,
    el.id ? `#${el.id}` : "",
    (el.classes ?? []).length ? `.${(el.classes ?? []).join(".")}` : "",
  ].join("");

  lines.push(`element ${index}: ${trunc(name, 160)}`);
  if (el.component)
    lines.push(`component: <${el.component}>${el.framework ? ` (${el.framework})` : ""}`);
  if (el.source) lines.push(`source: ${el.source}`);

  const text = (el.text ?? "").trim().replace(/\s+/g, " ");
  if (text) lines.push(`text: ${JSON.stringify(trunc(text, 200))}`);

  lines.push(`selector: ${trunc(el.selector, 200)}`);
  lines.push(`xpath: ${trunc(el.xpath, 200)}`);
  lines.push(
    `box: ${Math.round(el.rect.w)}×${Math.round(el.rect.h)} at (${Math.round(el.rect.x)}, ${Math.round(el.rect.y)})`,
  );

  const props = formatProps(el.props);
  if (props) lines.push(`props: ${props}`);

  const styles = formatStyles(el.styles);
  if (styles) lines.push(`styles: ${styles}`);

  const attrs = Object.entries(el.attrs ?? {})
    .map(([k, v]) => `${k}=${JSON.stringify(trunc(v, 40))}`)
    .join(" ");
  if (attrs) lines.push(`attributes: ${trunc(attrs, 300)}`);

  if (el.parent)
    lines.push(
      `parent: ${trunc(el.parent, 100)}${
        el.siblingCount ? ` (${el.siblingCount} children)` : ""
      }`,
    );

  if (candidates.length > 0)
    lines.push(`likely source files: ${candidates.join(", ")}`);

  return lines.join("\n");
}

/**
 * The whole selection, as one block appended to the user's message.
 *
 * Tagged rather than prose so the model can tell where the user's own words
 * end and the machine-collected context begins.
 */
export function formatSelection(
  payload: SelectionPayload,
  candidatesByIndex: Record<number, string[]> = {},
): string {
  const head = [
    `page: ${payload.title || "(untitled)"} — ${payload.url}`,
    `viewport: ${payload.viewport.w}×${payload.viewport.h}${
      payload.viewport.dpr !== 1 ? ` @${payload.viewport.dpr}x` : ""
    }`,
  ];
  if (payload.region)
    head.push(
      `region marked: ${Math.round(payload.region.w)}×${Math.round(payload.region.h)} at (${Math.round(payload.region.x)}, ${Math.round(payload.region.y)})`,
    );

  const blocks = payload.elements.map((el, i) =>
    formatElement(el, i + 1, candidatesByIndex[i] ?? []),
  );

  const tail =
    payload.elements.length > 1
      ? "\nThe user selected these together — the change likely concerns how they relate."
      : "";

  return [
    "<selected-from-browser>",
    head.join("\n"),
    "",
    blocks.join("\n\n"),
    tail,
    "</selected-from-browser>",
  ]
    .filter((s) => s !== "")
    .join("\n");
}
