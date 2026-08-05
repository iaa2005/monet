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
 *   - one editor per viewer card, disposed with it (the MODEL outlives it —
 *     see monaco-project: models are the project's memory, not the panel's);
 *   - the app's own theme, derived from the CSS variables already in use, so
 *     a file looks like the rest of the app rather than like VS Code;
 *   - editing is a prop, and the caller decides who gets it.
 *
 * Workers: Monaco wants one per language service. The local worker module
 * below bundles them, and the environment hook hands the right one over —
 * without it Monaco silently runs them on the main thread, which is the whole
 * problem again.
 */

import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { useIsDark } from "./chat/highlight";
import { CODE_THEME_EVENT } from "../lib/code-theme";
import {
  configureMonaco,
  loadProjectGraph,
  modelFor,
  takeReveal,
} from "./monaco-project";
import { languageOf } from "./monaco-langs";

self.MonacoEnvironment = {
  // The label is the language service asking. TypeScript and JavaScript share
  // one worker and it is NOT the base editor worker — that one answers a
  // completion request with "Missing requestHandler", which is exactly how a
  // dead IntelliSense looks from the outside.
  getWorker: (_id: string, label: string) =>
    label === "typescript" || label === "javascript"
      ? new Worker(new URL("../workers/ts.worker.ts", import.meta.url), {
          type: "module",
        })
      : new Worker(new URL("../workers/monaco.worker.ts", import.meta.url), {
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
  // The code-theme variables (Settings → Editor, lib/code-theme.ts) hold
  // plain hex — the same palette the chat's code blocks read. Mapping them
  // onto Monaco's token names is what keeps the file viewer and a ```block
  // in a message coloured by one theme.
  const code = (name: string): string | undefined => {
    const v = css.getPropertyValue(name).trim();
    return /^#[0-9a-f]{6}$/i.test(v) ? v.slice(1) : undefined;
  };
  const rule = (token: string, name: string): monaco.editor.ITokenThemeRule[] => {
    const foreground = code(name);
    return foreground ? [{ token, foreground }] : [];
  };
  return {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      ...rule("comment", "--code-comment"),
      ...rule("string", "--code-string"),
      ...rule("keyword", "--code-keyword"),
      ...rule("number", "--code-const"),
      ...rule("constant", "--code-const"),
      ...rule("regexp", "--code-string"),
      ...rule("type", "--code-class"),
      ...rule("type.identifier", "--code-class"),
      ...rule("function", "--code-func"),
      ...rule("variable", "--code-var"),
      ...rule("tag", "--code-tag"),
      ...rule("attribute.name", "--code-const"),
      ...rule("attribute.value", "--code-string"),
      ...rule("operator", "--code-op"),
      ...rule("delimiter", "--code-punct"),
    ],
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

/** A selection, plus where to put a button beside it (editor pixels). */
export interface CodeSelection {
  startLine: number;
  endLine: number;
  text: string;
  top: number;
  left: number;
}

export function CodeEditor({
  value,
  fileName,
  filePath,
  readOnly = true,
  onChange,
  onSave,
  onSelect,
  onAddSelection,
  className,
}: {
  value: string;
  fileName: string;
  /** Absolute path. Gives the model a file identity, which is what lets the
   *  language service resolve this file's imports against the project. */
  filePath?: string;
  readOnly?: boolean;
  onChange?: (next: string) => void;
  /** Ctrl/⌘+S. Absent means the file is not savable from here. */
  onSave?: (text: string) => void;
  /** Where the selection is, in editor pixels, so the caller can float a
   *  button beside it. Null when nothing is selected. */
  onSelect?: (sel: CodeSelection | null) => void;
  /** "Add to chat", from the button or the editor's own context menu. */
  onAddSelection?: (sel: { startLine: number; endLine: number; text: string }) => void;
  className?: string;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const dark = useIsDark();
  // Read by the save command, which is bound once and must not capture a
  // stale handler.
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const addRef = useRef(onAddSelection);
  addRef.current = onAddSelection;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    configureMonaco();
    monaco.editor.defineTheme("monet", readTheme(dark));
    const language = languageOf(fileName);
    const model = filePath
      ? modelFor(filePath, value, language)
      : monaco.editor.createModel(value, language);
    const editor = monaco.editor.create(host, {
      model,
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
      quickSuggestions: true,
      suggestOnTriggerCharacters: true,
      tabSize: 2,
    });
    editorRef.current = editor;

    // Ctrl/⌘+S. An action rather than a raw keybinding so it also appears in
    // the editor's command palette (F1), where a user goes looking for it.
    editor.addAction({
      id: "monet.save",
      label: "Save File",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: (ed) => saveRef.current?.(ed.getValue()),
    });

    // Selecting code offers it to the chat. Monaco owns its selection (there
    // is no DOM range to read), so the offer is built from the editor's own
    // API — and it is an ACTION as well as a button, which puts it in the
    // right-click menu where a selection is already under the cursor.
    const currentSelection = (): CodeSelection | null => {
      const sel = editor.getSelection();
      const m = editor.getModel();
      if (!sel || !m || sel.isEmpty()) return null;
      const at = editor.getScrolledVisiblePosition({
        lineNumber: sel.endLineNumber,
        column: sel.endColumn,
      });
      return {
        startLine: sel.startLineNumber,
        endLine: sel.endLineNumber,
        text: m.getValueInRange(sel),
        top: (at?.top ?? 0) + (at?.height ?? 18) + 4,
        left: Math.max(8, at?.left ?? 8),
      };
    };
    const report = (): void => selectRef.current?.(currentSelection());
    editor.addAction({
      id: "monet.addToChat",
      label: "Add selection to chat",
      contextMenuGroupId: "9_cutcopypaste",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
      run: () => {
        const sel = currentSelection();
        if (sel) addRef.current?.(sel);
      },
    });

    const subs = [
      editor.onDidChangeCursorSelection(report),
      editor.onDidScrollChange(report),
    ];
    const sub = onChange
      ? editor.onDidChangeModelContent(() => onChange(editor.getValue()))
      : null;

    // Loading the imports is what turns "one file" into "the project"; it is
    // IPC-bound, so it happens after the editor is on screen, never before.
    if (filePath) {
      void loadProjectGraph(filePath, value);
      const reveal = takeReveal(filePath);
      if (reveal) {
        const pos =
          "startLineNumber" in reveal
            ? { lineNumber: reveal.startLineNumber, column: reveal.startColumn }
            : reveal;
        editor.setPosition(pos);
        editor.revealLineInCenter(pos.lineNumber);
      }
    }

    return () => {
      sub?.dispose();
      for (const d of subs) d.dispose();
      selectRef.current?.(null);
      // The model is NOT disposed: it belongs to the project's view of itself,
      // and dropping it would make every file that imports this one forget
      // what is in it.
      editor.dispose();
      editorRef.current = null;
    };
    // The editor is created once per file; value/theme changes are applied
    // below without tearing it down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName, filePath]);

  // Content that changed underneath (a reload, a different revision).
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value]);

  useEffect(() => {
    const retheme = (): void => {
      monaco.editor.defineTheme("monet", readTheme(dark));
      monaco.editor.setTheme("monet");
    };
    retheme();
    // Settings → Editor changed the palette: the CSS variables are already
    // new, Monaco just has to read them again.
    window.addEventListener(CODE_THEME_EVENT, retheme);
    return () => window.removeEventListener(CODE_THEME_EVENT, retheme);
  }, [dark]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return <div ref={hostRef} className={className ?? "h-full w-full"} />;
}
