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
import { chipColors, toneForLabel } from "@shared/selection-tones";
import { refToken, tokenize } from "@/lib/selection-marks";
import { useIsDark } from "./highlight";

export interface TokenInputHandle {
  focus(): void;
  /** The plain string, tokens and all. */
  getText(): string;
  /** Replace everything (draft restore, clear after send). */
  setText(text: string): void;
  /** Drop a chip in at the caret. */
  insertChip(label: string, tone: number): void;
  /** Caret offset into the plain string, for the "/" menu. */
  caretOffset(): number;
}

interface TokenInputProps {
  /** Initial value only — this input is uncontrolled by design (see above). */
  initialText: string;
  onChange(text: string): void;
  onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void;
  placeholder: string;
  className?: string;
}

const CHIP_ATTR = "data-monet-chip";

/**
 * lucide's square-mouse-pointer, inline.
 *
 * Written out rather than imported: this chip is built with createElement, not
 * JSX, because the input hands raw nodes to the browser. Same two paths as the
 * React component the transcript uses, so both ends show one icon.
 */
const ICON =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none">' +
  '<path d="M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"/>' +
  '<path d="m12 12 4 10 1.7-4.3L22 16Z"/></svg>';

function chipNode(label: string, tone: number, dark: boolean): HTMLElement {
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
    "border-radius:999px",
    "font-weight:600",
    "white-space:nowrap",
    "user-select:none",
    `color:${c.fg}`,
    `background:${c.bg}`,
  ].join(";");
  el.innerHTML = ICON;
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

/** The plain string → DOM. */
function render(root: HTMLElement, text: string, dark: boolean): void {
  root.textContent = "";
  for (const piece of tokenize(text)) {
    if (piece.type === "chip") {
      root.appendChild(chipNode(piece.label, toneForLabel(piece.label), dark));
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
    { initialText, onChange, onKeyDown, placeholder, className },
    ref,
  ) {
    const boxRef = useRef<HTMLDivElement>(null);
    const dark = useIsDark();
    // What we last handed out, so an external setText can skip a no-op render
    // that would otherwise move the caret to the end mid-typing.
    const lastText = useRef(initialText);

    useLayoutEffect(() => {
      const box = boxRef.current;
      if (!box) return;
      render(box, initialText, dark);
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
      onChange(text);
    };

    useImperativeHandle(ref, () => ({
      focus: () => boxRef.current?.focus(),
      getText: () => (boxRef.current ? serialize(boxRef.current) : ""),
      setText: (text) => {
        const box = boxRef.current;
        if (!box || text === lastText.current) return;
        render(box, text, dark);
        lastText.current = text;
        placeCaretAtEnd(box);
        onChange(text);
      },
      insertChip: (label, tone) => {
        const box = boxRef.current;
        if (!box) return;
        box.focus();
        insertAtCaret(box, chipNode(label, tone, dark));
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
                chipNode(piece.label, toneForLabel(piece.label), dark),
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
