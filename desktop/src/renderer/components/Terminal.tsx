/**
 * Terminal — xterm.js attached to a live pty in main.
 *
 * This used to be a REPL pretending to be a terminal: it collected a line,
 * sent it off as one command, waited for the process to exit and printed the
 * result. Everything a terminal is for fell out of that — `cd` was forgotten
 * by the next line, `npm run dev` showed nothing until the five-minute timeout
 * killed it, Ctrl+C printed "^C" and killed nothing, and the output was
 * monochrome because a program with no tty turns its own colours off.
 *
 * Now the shell lives in main (terminal/sessions.ts) and this is a view onto
 * it. Which means the component owns almost nothing: keystrokes go straight
 * out, bytes come straight in, and unmounting closes NOTHING — leave the chat
 * with a build running and it is still running when you come back, with its
 * scrollback redrawn from the buffer main kept.
 */

import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import type { ElectronAPI } from "@/types/electron";

const LIGHT_THEME = {
  background: "transparent",
  foreground: "#1a1a1a",
  cursor: "#1a1a1a",
  cursorAccent: "#ffffff",
  selectionBackground: "#0073e620",
  black: "#f0f0f0",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#ca8a04",
  blue: "#2563eb",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#1a1a1a",
  brightBlack: "#e5e5e5",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#eab308",
  brightBlue: "#3b82f6",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#404040",
};

const DARK_THEME = {
  background: "transparent",
  foreground: "#e5e7eb",
  cursor: "#e5e7eb",
  cursorAccent: "#111827",
  selectionBackground: "#ffffff15",
  black: "#1f2937",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e5e7eb",
  brightBlack: "#374151",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f9fafb",
};

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

interface TerminalProps {
  /** Which shell to show. The panel owns the list; this shows one of them. */
  terminalId: string;
}

export function Terminal({ terminalId }: TerminalProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const themeRef = useRef(isDark());

  useEffect(() => {
    if (!containerRef.current) return;
    const bridge = api();

    const theme = isDark() ? { ...DARK_THEME } : { ...LIGHT_THEME };
    const cardBg =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--card")
        .trim() || theme.background;
    if (cardBg) theme.background = cardBg;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        '"Consolas", "Consolas Powerline", "Cascadia Code", ui-monospace, monospace',
      theme,
      allowProposedApi: true,
      // What a shell keeps of what scrolled past. The pty has no memory of it
      // and main's buffer is the reload copy; this is the one you can scroll.
      scrollback: 10_000,
    });

    // Ctrl+Shift+C/V for copy/paste — Ctrl+C belongs to the process now, and
    // sending SIGINT is the whole reason it does.
    term.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && e.shiftKey && e.key === "C") {
        const sel = term.getSelection();
        if (sel) {
          void navigator.clipboard.writeText(sel);
          return false;
        }
      }
      if (e.ctrlKey && e.shiftKey && e.key === "V") {
        void navigator.clipboard.readText().then((t) => {
          if (t) term.paste(t);
        });
        return false;
      }
      return true;
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    let alive = true;
    // Only this terminal's bytes. One channel carries every shell in the app:
    // without the filter, a build running in another tab would type into
    // whichever one is on screen.
    const offData = bridge?.sandbox.terminal.onData((id, data) => {
      if (id === terminalId) term.write(data);
    });

    void (async () => {
      // Reattach — the id already exists; the panel created it.
      const r = await bridge?.sandbox.terminal.open(
        "",
        undefined,
        term.cols,
        term.rows,
        terminalId,
      );
      if (!alive) return;
      if (!r?.ok) {
        term.write(`\x1b[31m${r?.error ?? "Could not start a shell."}\x1b[0m\r\n`);
        return;
      }
      // Everything main saw while this tab was not on screen. Written before
      // the input is wired up so a keystroke cannot land mid-redraw.
      if (r.buffer) term.write(r.buffer);
      term.onData((data) => bridge?.sandbox.terminal.write(terminalId, data));
      term.focus();
    })();

    const observer = new MutationObserver(() => {
      const dark = isDark();
      if (dark !== themeRef.current) {
        themeRef.current = dark;
        const t = dark ? { ...DARK_THEME } : { ...LIGHT_THEME };
        const bg =
          getComputedStyle(document.documentElement)
            .getPropertyValue("--card")
            .trim() || t.background;
        if (bg) t.background = bg;
        term.options.theme = t;
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    // The pty has to be told the size, or a full-screen program draws for the
    // wrong window and progress bars wrap.
    const ro = new ResizeObserver(() => {
      fit.fit();
      bridge?.sandbox.terminal.resize(terminalId, term.cols, term.rows);
    });
    ro.observe(containerRef.current);

    return () => {
      alive = false;
      offData?.();
      observer.disconnect();
      ro.disconnect();
      // Disposes the VIEW. The shell in main keeps running — see the note at
      // the top: that is the feature, not an oversight.
      term.dispose();
    };
  }, [terminalId]);

  return (
    <div className="h-full w-full overflow-hidden p-2">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
