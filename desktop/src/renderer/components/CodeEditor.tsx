/**
 * The file viewer's code surface — Monaco, the editor VS Code is built on.
 *
 * What this replaces: a hand-rolled virtualized renderer (windowed rows,
 * block tokenizing, an idle scheduler, a sticky rows layer) that took a week
 * of measurements to get from 6.8 seconds to 51ms on one HTML file. Monaco
 * does all of that natively and better, and it brings the things the custom
 * one would have needed next anyway — find, folding, minimap, selection,
 * multi-cursor, real editing.
 *
 * Kept deliberately small:
 *   - one editor per viewer pane, disposed with it;
 *   - the app's own theme, derived from the CSS variables already in use, so
 *     a file looks like the rest of the app rather than like VS Code;
 *   - read-only by default, with `onChange` the only thing standing between
 *     this and an editor.
 *
 * Workers: Monaco wants one per language service. Vite's `?worker` imports
 * bundle them, and the environment hook below hands the right one over —
 * without it Monaco silently falls back to running them on the main thread,
 * which is the whole problem again.
 */

import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { useIsDark } from "./chat/highlight";

self.MonacoEnvironment = {
  getWorker: () =>
    new Worker(new URL("../workers/monaco.worker.ts", import.meta.url), {
      type: "module",
    }),
};

/** The app's palette, read from the CSS variables the rest of the UI uses. */
function readTheme(dark: boolean): monaco.editor.IStandaloneThemeData {
  const css = getComputedStyle(document.documentElement);
  const hsl = (name: string): string => {
    const v = css.getPropertyValue(name).trim();
    return v ? `hsl(${v})` : "";
  };
  // Monaco wants hex; let the browser convert by painting into a canvas-free
  // probe element rather than parsing HSL by hand.
  const toHex = (color: string): string | undefined => {
    if (!color) return undefined;
    const el = document.createElement("span");
    el.style.color = color;
    document.body.appendChild(el);
    const rgb = getComputedStyle(el).color;
    el.remove();
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
    if (!m) return undefined;
    return (
      "#" +
      [m[1], m[2], m[3]]
        .map((n) => Number(n).toString(16).padStart(2, "0"))
        .join("")
    );
  };
  const bg = toHex(hsl("--bg-000")) ?? (dark ? "#121212" : "#ffffff");
  const fg = toHex(hsl("--text-000")) ?? (dark ? "#d4d4d4" : "#141413");
  const dim = toHex(hsl("--text-400")) ?? (dark ? "#9e9e9e" : "#6b6b6b");
  return {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": bg,
      "editor.foreground": fg,
      "editorLineNumber.foreground": dim,
      "editorGutter.background": bg,
      "editorWidget.background": bg,
      "editor.lineHighlightBorder": "#00000000",
    },
  };
}

/** Monaco's id for a file name — its own table, not ours. */
export function languageOf(fileName: string): string {
  const ext = "." + (fileName.split(".").pop() ?? "").toLowerCase();
  for (const lang of monaco.languages.getLanguages())
    if (lang.extensions?.some((e) => e.toLowerCase() === ext)) return lang.id;
  return "plaintext";
}

export function CodeEditor({
  value,
  fileName,
  readOnly = true,
  onChange,
  className,
}: {
  value: string;
  fileName: string;
  readOnly?: boolean;
  onChange?: (next: string) => void;
  className?: string;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const dark = useIsDark();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    monaco.editor.defineTheme("monet", readTheme(dark));
    const editor = monaco.editor.create(host, {
      value,
      language: languageOf(fileName),
      theme: "monet",
      readOnly,
      automaticLayout: true,
      fontFamily: "var(--font-mono)",
      fontSize: 12.5,
      lineHeight: 20,
      minimap: { enabled: true, renderCharacters: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      smoothScrolling: true,
      padding: { top: 8, bottom: 8 },
      // The dock panel owns the scrollbar's look elsewhere; keep Monaco's own
      // so the editor scrolls like an editor.
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });
    editorRef.current = editor;
    const sub = onChange
      ? editor.onDidChangeModelContent(() => onChange(editor.getValue()))
      : null;
    return () => {
      sub?.dispose();
      editor.getModel()?.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // The editor is created once per file; value/theme changes are applied
    // below without tearing it down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName]);

  // Content that changed underneath (a reload, a different revision).
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value]);

  useEffect(() => {
    monaco.editor.defineTheme("monet", readTheme(dark));
    monaco.editor.setTheme("monet");
  }, [dark]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return <div ref={hostRef} className={className ?? "h-full w-full"} />;
}
