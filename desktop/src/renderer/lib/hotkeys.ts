/**
 * One keymap for the whole app.
 *
 * Shortcuts used to accrete as private keydown listeners (settings here,
 * design mode there) — each new one risked a silent collision and none were
 * discoverable. This is the single registry: App declares the map once,
 * `useHotkeys` installs ONE window listener, and the cheatsheet (Ctrl+/)
 * renders from the same data, so the help can never drift from the behavior.
 *
 * "mod" is Ctrl on Windows/Linux and ⌘ on macOS — the Cursor/Claude Desktop
 * convention, so habits transfer. Combos always carry a modifier, which is
 * why they may fire while typing: Ctrl+B in a textarea is a command, not
 * text.
 */

import { useEffect, useRef } from "react";

export interface HotkeyDef {
  /** "mod+shift+e", "mod+`", "mod+/" — lowercase, "+"-joined. */
  combo: string;
  /** Cheatsheet text, e.g. "Toggle sidebar". */
  label: string;
  /** Cheatsheet section, e.g. "Panels". */
  section: string;
  action: () => void;
  /** Hidden from the cheatsheet (internal or duplicate binding). */
  hidden?: boolean;
}

export const isMac: boolean =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

interface ParsedCombo {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

function parse(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split("+");
  return {
    mod: parts.includes("mod"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
    key: parts[parts.length - 1],
  };
}

function matches(e: KeyboardEvent, c: ParsedCombo): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (c.mod !== mod) return false;
  if (c.shift !== e.shiftKey) return false;
  if (c.alt !== e.altKey) return false;
  // e.key for letters respects Shift ("E") and layouts; compare lowercased.
  // For Cyrillic layouts fall back to the physical key (KeyE → "e") so the
  // shortcuts survive a layout switch — Ctrl+Shift+Е is still Files.
  const key = e.key.toLowerCase();
  if (key === c.key) return true;
  const code = e.code.toLowerCase();
  if (c.key.length === 1 && code === `key${c.key}`) return true;
  if (c.key === "`" && code === "backquote") return true;
  if (c.key === "/" && code === "slash") return true;
  if (c.key === "," && code === "comma") return true;
  return false;
}

/** Human-readable combo for the current platform: "Ctrl+Shift+E" / "⌘⇧E". */
export function comboLabel(combo: string): string {
  const parts = combo.split("+");
  if (isMac) {
    return parts
      .map((p) =>
        p === "mod" ? "⌘" : p === "shift" ? "⇧" : p === "alt" ? "⌥" : keyCap(p),
      )
      .join("");
  }
  return parts
    .map((p) =>
      p === "mod" ? "Ctrl" : p === "shift" ? "Shift" : p === "alt" ? "Alt" : keyCap(p),
    )
    .join("+");
}

function keyCap(k: string): string {
  if (k === "enter") return "⏎";
  if (k === "`") return "`";
  return k.length === 1 ? k.toUpperCase() : k;
}

/** Install the keymap. One listener; defs are read through a ref so callers
 * may pass a fresh array every render without re-subscribing. */
export function useHotkeys(defs: HotkeyDef[]): void {
  const ref = useRef(defs);
  ref.current = defs;
  useEffect(() => {
    const parsedOf = new WeakMap<HotkeyDef, ParsedCombo>();
    const onKey = (e: KeyboardEvent): void => {
      // A bare-modifier press, or IME composition, is never a command.
      if (e.isComposing || e.key === "Control" || e.key === "Meta" || e.key === "Shift")
        return;
      for (const def of ref.current) {
        let p = parsedOf.get(def);
        if (!p) {
          p = parse(def.combo);
          parsedOf.set(def, p);
        }
        if (matches(e, p)) {
          e.preventDefault();
          def.action();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
