/**
 * The composer, as a contenteditable, so a reference can be a real chip.
 *
 * A textarea cannot style part of its value. The previous attempt drew a tinted
 * layer behind it, which got the box right and could never get the glyphs — a
 * chip needs coloured text and an icon, and both are the textarea's to draw.
 *
 * The risk with contenteditable is React: re-rendering children from state on
 * every keystroke fights the browser for the caret, breaks IME composition mid
 * word, and throws away native undo. So React does NOT own the children. The
 * element is written to only on discrete events — mount, a chip inserted, a
 * draft restored — and read back on input. Between those the browser is left
 * alone, which is what keeps typing, undo, and composing in another language
 * behaving like a normal text box.
 *
 * The plain string with ⟨tokens⟩ stays the model of record; this is a view of
 * it that happens to be editable.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { CHIP_ATTR } from "@shared/brand";
import { chipColors, toneForLabel } from "@shared/selection-tones";
import { chipIconSvg } from "./chip-icons";
import type { RefKind } from "@/lib/selection-marks";
import { refToken, tokenize } from "@/lib/selection-marks";
import { useIsDark } from "./highlight";

export interface TokenInputHandle {
  focus(): void;
  /** The plain string, tokens and all. */
  getText(): string;
  /** Replace everything (draft restore, clear after send). */
  setText(text: string): void;
  /** Drop a chip in at the caret. */
  insertChip(label: string, tone: number, kind?: RefKind): void;
  /** Caret offset into the plain string, for the "/" menu. */
  caretOffset(): number;
}

interface TokenInputProps {
  /** Initial value only — this input is uncontrolled by design (see above). */
  initialText: string;
  /**
   * The palette slot for a label, for chips rendered from TEXT (a restored
   * draft, a paste). Text carries labels only; without this the colour is
   * hashed and a chip changes shade between the composer and the message.
   * A callback rather than a map for the same reason as `kindFor`: the chip
   * is often drawn in the tick its selection was registered.
   */
  toneFor?: (label: string) => number | undefined;
  /** What KIND a label refers to, asked at draw time rather than passed as a
   *  snapshot: a mention inserts its chip in the same tick it registers its
   *  context, so any map handed down as a prop is still the previous one. */
  kindFor?: (label: string) => RefKind | undefined;
  onChange(text: string): void;
  onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void;
  placeholder: string;
  className?: string;
}



function chipNode(
  label: string,
  tone: number,
  dark: boolean,
  kind: RefKind,
): HTMLElement {
  const c = chipColors(tone, dark);
  const el = document.createElement("span");
  el.setAttribute(CHIP_ATTR, label);
  el.setAttribute("data-tone", String(tone));
  // The whole reason for the rewrite: the browser treats this as one
  // character. Backspace removes it whole, a click selects it whole, and a
  // copy takes it whole.
  el.contentEditable = "false";
  el.style.cssText = [
    "display:inline-flex",
    "align-items:center",
    "gap:4px",
    "vertical-align:baseline",
    "margin:0 1px",
    "padding:1px 7px 1px 6px",
    "border-radius: calc(var(--radius)* 0.5);",
    "white-space:nowrap",
    "user-select:none",
    `color:${c.fg}`,
    `background:${c.bg}`,
  ].join(";");
  el.innerHTML = chipIconSvg(kind);
  el.appendChild(document.createTextNode(label));
  return el;
}

/** DOM → the plain string. */
function serialize(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? "";
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const chip = node.getAttribute(CHIP_ATTR);
    if (chip !== null) {
      out += refToken(chip);
      return;
    }
    if (node.tagName === "BR") {
      out += "\n";
      return;
    }
    // A contenteditable turns Enter into <div> or <p> siblings depending on
    // the browser's mood; either way each one starts a line.
    const block = node !== root && /^(DIV|P)$/.test(node.tagName);
    if (block && out && !out.endsWith("\n")) out += "\n";
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  for (const child of Array.from(root.childNodes)) walk(child);
  return out;
}

/**
 * The palette slot for a label.
 *
 * A string of text carries labels, not tones — so a draft restored from
 * storage, or a chip pasted from another message, can only hash the label.
 * When the caller KNOWS the tone (a live selection, or one re-staged from a
 * message that recorded it), that wins: the chip then matches the outline the
 * page drew and the chip the sent message shows.
 */
function toneOf(
  label: string,
  toneFor?: (l: string) => number | undefined,
  seen?: Map<string, Drawn>,
): number {
  const known = toneFor?.(label) ?? seen?.get(label)?.tone;
  return typeof known === "number" ? known : toneForLabel(label);
}

/** Browser is the fallback: it is what every chip was before kinds existed. */
function kindOfLabel(
  label: string,
  kindFor?: (l: string) => RefKind | undefined,
  seen?: Map<string, Drawn>,
): RefKind {
  return kindFor?.(label) ?? seen?.get(label)?.kind ?? "browser";
}

/**
 * What a label was last drawn as.
 *
 * A chip only knows its colour and its icon while its selection is in the
 * store, and the store is emptied on send — so a chip still standing in the
 * composer (a restored draft, a message being re-staged) redrew as a grey
 * browser pick the next time anything re-rendered. Reported as chips
 * changing colour and losing their icon on their own. What was drawn once is
 * remembered for as long as the composer lives.
 */
interface Drawn {
  tone: number;
  kind: RefKind;
}

/**
 * A slash COMMAND, not a slash in a sentence.
 *
 * The rule is the one the send path uses: a command is the first thing in the
 * message. That alone rules out "put it in src/utils"; the shape rules out a
 * path typed first ("/etc/hosts is broken" has a second slash, so it is not a
 * command) and a lone "/" while the menu is still open.
 */
function commandLength(text: string): number {
  const word = text.split(/\s/, 1)[0] ?? "";
  return /^\/[A-Za-z][A-Za-z0-9_:-]*$/.test(word) ? word.length : 0;
}

/**
 * Painted with the CSS Custom Highlight API rather than by wrapping the text
 * in a span: the composer's DOM belongs to the browser between events, and
 * rewriting it on every keystroke is exactly what this input exists to avoid
 * (it fights the caret, breaks IME composition, and drops native undo). A
 * highlight is a range laid OVER the text and touches nothing.
 */
const COMMAND_HIGHLIGHT = "monet-command";
const commandRanges = new Map<HTMLElement, Range>();

function paintCommand(box: HTMLElement): void {
  const registry = (
    CSS as unknown as { highlights?: Map<string, Highlight> }
  ).highlights;
  if (!registry) return; // older Chromium: no colour, everything else works
  commandRanges.delete(box);
  for (const el of Array.from(commandRanges.keys()))
    if (!el.isConnected) commandRanges.delete(el);

  const first = box.firstChild;
  if (first && first.nodeType === Node.TEXT_NODE) {
    const len = commandLength(first.nodeValue ?? "");
    if (len > 0) {
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(first, len);
      commandRanges.set(box, range);
    }
  }
  if (commandRanges.size === 0) registry.delete(COMMAND_HIGHLIGHT);
  else registry.set(COMMAND_HIGHLIGHT, new Highlight(...commandRanges.values()));
}

/** The plain string → DOM. */
function render(
  root: HTMLElement,
  text: string,
  dark: boolean,
  toneFor?: (label: string) => number | undefined,
  kindFor?: (label: string) => RefKind | undefined,
  seen?: Map<string, Drawn>,
): void {
  root.textContent = "";
  for (const piece of tokenize(text)) {
    if (piece.type === "chip") {
      const tone = toneOf(piece.label, toneFor, seen);
      const kind = kindOfLabel(piece.label, kindFor, seen);
      // Remember it while the store still knows: after the next send it will
      // not, and this chip must not change under the user.
      if (seen && (toneFor?.(piece.label) !== undefined || kindFor?.(piece.label)))
        seen.set(piece.label, { tone, kind });
      root.appendChild(chipNode(piece.label, tone, dark, kind));
      continue;
    }
    const lines = piece.value.split("\n");
    lines.forEach((line, i) => {
      if (i > 0) root.appendChild(document.createElement("br"));
      if (line) root.appendChild(document.createTextNode(line));
    });
  }
}

export const TokenInput = forwardRef<TokenInputHandle, TokenInputProps>(
  function TokenInput(
    { initialText, toneFor, kindFor, onChange, onKeyDown, placeholder, className },
    ref,
  ) {
    const boxRef = useRef<HTMLDivElement>(null);
    // Handlers below run on DOM events, outside React's render — they need the
    // current map, not the one captured when they were attached.
    const toneRef = useRef(toneFor);
    toneRef.current = toneFor;
    const kindRef = useRef(kindFor);
    kindRef.current = kindFor;
    const seen = useRef(new Map<string, Drawn>());
    const dark = useIsDark();
    // What we last handed out, so an external setText can skip a no-op render
    // that would otherwise move the caret to the end mid-typing.
    const lastText = useRef(initialText);

    useLayoutEffect(() => {
      const box = boxRef.current;
      if (!box) return;
      render(box, initialText, dark, toneRef.current, kindRef.current, seen.current);
      paintCommand(box);
      lastText.current = initialText;
      // Only on mount: after that the DOM is the browser's.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // A theme flip has to recolour existing chips, and only those.
    useEffect(() => {
      const box = boxRef.current;
      if (!box) return;
      for (const el of Array.from(box.querySelectorAll(`[${CHIP_ATTR}]`))) {
        if (!(el instanceof HTMLElement)) continue;
        const c = chipColors(Number(el.dataset.tone ?? 0), dark);
        el.style.color = c.fg;
        el.style.background = c.bg;
      }
    }, [dark]);

    const emit = (): void => {
      const box = boxRef.current;
      if (!box) return;
      const text = serialize(box);
      lastText.current = text;
      paintCommand(box);
      onChange(text);
    };

    useImperativeHandle(ref, () => ({
      focus: () => boxRef.current?.focus(),
      getText: () => (boxRef.current ? serialize(boxRef.current) : ""),
      setText: (text) => {
        const box = boxRef.current;
        if (!box || text === lastText.current) return;
        render(box, text, dark, toneRef.current, kindRef.current, seen.current);
        lastText.current = text;
        paintCommand(box);
        placeCaretAtEnd(box);
        onChange(text);
      },
      insertChip: (label, tone, kind) => {
        const box = boxRef.current;
        if (!box) return;
        box.focus();
        const drawnKind =
          kind ?? kindOfLabel(label, kindRef.current, seen.current);
        seen.current.set(label, { tone, kind: drawnKind });
        insertAtCaret(box, chipNode(label, tone, dark, drawnKind));
        emit();
      },
      caretOffset: () => (boxRef.current ? caretOffsetIn(boxRef.current) : 0),
    }));

    return (
      <div
        ref={boxRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        onInput={emit}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          // Paste plain text, and let ⟨tokens⟩ in it become chips again — so
          // copying a chip out of one message and into another works.
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain");
          if (!text) return;
          const box = boxRef.current;
          if (!box) return;
          const frag = document.createDocumentFragment();
          for (const piece of tokenize(text)) {
            if (piece.type === "chip") {
              frag.appendChild(
                chipNode(
                  piece.label,
                  toneOf(piece.label, toneRef.current, seen.current),
                  dark,
                  kindOfLabel(piece.label, kindRef.current, seen.current),
                ),
              );
            } else {
              piece.value.split("\n").forEach((line, i) => {
                if (i > 0) frag.appendChild(document.createElement("br"));
                if (line) frag.appendChild(document.createTextNode(line));
              });
            }
          }
          insertAtCaret(box, frag);
          emit();
        }}
        className={className}
      />
    );
  },
);

// ─── Caret plumbing ───────────────────────────────────────────────────────

function insertAtCaret(root: HTMLElement, node: Node): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) {
    root.appendChild(node);
    placeCaretAtEnd(root);
    return;
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  // A trailing space so the next word does not run into the chip, and so the
  // caret has somewhere to be that is not inside it.
  const after = document.createTextNode(" ");
  range.insertNode(after);
  range.insertNode(node);
  range.setStartAfter(after);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtEnd(root: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** How much text precedes the caret, counting a chip as its ⟨token⟩. */
function caretOffsetIn(root: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) return 0;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(root);
  range.setEnd(sel.anchorNode!, sel.anchorOffset);
  const clone = document.createElement("div");
  clone.appendChild(range.cloneContents());
  return serialize(clone).length;
}
