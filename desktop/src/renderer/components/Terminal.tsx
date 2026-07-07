/**
 * Terminal — xterm.js with theme-aware colors, Cyrillic support, Consolas Powerline.
 */

import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import type { ElectronAPI } from "@/types/electron";

const LIGHT_THEME = {
  background: "#ffffff",
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
  background: "#111827",
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

export function Terminal(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const inputBuffer = useRef("");
  const themeRef = useRef(isDark());

  useEffect(() => {
    if (!containerRef.current) return;

    const theme = isDark() ? DARK_THEME : LIGHT_THEME;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        '"Consolas", "Consolas Powerline", "Cascadia Code", ui-monospace, monospace',
      theme,
      allowProposedApi: true,
      cols: 80,
      rows: 24,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    fitRef.current = fit;

    termRef.current = term;

    term.writeln("Claude Code Desktop — Terminal");
    term.writeln("Type commands, Enter to run, Ctrl+C to cancel.");
    term.write("\r\n$ ");

    const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI;

    term.onData(async (data) => {
      if (data === "\r") {
        const cmd = inputBuffer.current.trim();
        term.write("\r\n");

        if (cmd === "clear" || cmd === "cls") {
          term.clear();
        } else if (cmd) {
          try {
            const result = await api.shell.run(cmd);
            if (result.stdout) term.write(result.stdout);
            if (result.stderr) term.write(result.stderr);
            if (result.error) term.write(`\x1b[31m${result.error}\x1b[0m`);
          } catch (err) {
            term.write(`\x1b[31mError: ${err}\x1b[0m`);
          }
        }

        inputBuffer.current = "";
        term.write("\r\n$ ");
      } else if (data === "\x7f") {
        if (inputBuffer.current.length > 0) {
          inputBuffer.current = inputBuffer.current.slice(0, -1);
          term.write("\b \b");
        }
      } else if (data === "\x03") {
        term.write("^C\r\n$ ");
        inputBuffer.current = "";
      } else if (data >= " ") {
        inputBuffer.current += data;
        term.write(data);
      }
    });

    // Listen for theme changes
    const observer = new MutationObserver(() => {
      const dark = isDark();
      if (dark !== themeRef.current) {
        themeRef.current = dark;
        term.options.theme = dark ? DARK_THEME : LIGHT_THEME;
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const handleResize = () => fit.fit();
    window.addEventListener("resize", handleResize);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleResize);
      term.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ padding: "4px" }}
    />
  );
}
