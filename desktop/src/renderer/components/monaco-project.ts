/**
 * What makes the editor know the project rather than one file.
 *
 * Monaco's TypeScript service is a real compiler, but it only sees the models
 * it has been given. Open one file and you get keywords and the words already
 * on screen; that is not "completions", that is a thesaurus. So when a file is
 * opened here its imports are followed — relative ones and the tsconfig `@/`
 * kind — and the files behind them are loaded as models too, one hop, then
 * another, under a budget. From that point the service answers about the
 * project: members of a type declared three files away, the exports of a
 * module, and Go to Definition can land in a file that was never opened.
 *
 * Deliberately NOT loaded: node_modules. It is tens of thousands of files for
 * a handful of completions, and Electron would feel it. The cost of that
 * choice is that imports of packages stay unresolved — which is exactly why
 * semantic diagnostics are off: without the packages' types every second line
 * would be a false red squiggle. Syntax errors, which need nothing external,
 * stay on.
 */

import * as monaco from "monaco-editor";
import type { ElectronAPI } from "@/types/electron";
import { useViewerStore } from "@/stores/viewerStore";
import { registerExtraLanguages } from "./monaco-langs";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/** Tried in order for an extensionless import, as tsc would. */
const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];

/** A budget, because an import graph has no natural end. */
const MAX_FILES = 150;
const MAX_DEPTH = 3;

const TS_LIKE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

const loaded = new Set<string>();

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function dirOf(p: string): string {
  const i = toPosix(p).lastIndexOf("/");
  return i < 0 ? "" : toPosix(p).slice(0, i);
}

/** Join and flatten `..`/`.` without a path module in the renderer. */
function joinPath(base: string, rel: string): string {
  const parts = toPosix(base).split("/");
  for (const seg of toPosix(rel).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** Every module specifier in a file, without parsing it. */
function importSpecifiers(text: string): string[] {
  const out: string[] = [];
  const re =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

// ── tsconfig: the `@/…` half of resolution ────────────────────────────

interface Aliases {
  /** Absolute directory the mappings are relative to. */
  baseDir: string;
  /** ["@/", "<baseDir>/src/renderer/"] — prefix form, which is all that is used. */
  prefixes: [string, string][];
}

const aliasCache = new Map<string, Aliases | null>();

/**
 * The nearest tsconfig above a file. The workspace root is often a level up
 * from the project that owns the config (a repo with the app in a subfolder),
 * so this walks rather than assumes.
 */
async function aliasesFor(filePath: string): Promise<Aliases | null> {
  let dir = dirOf(filePath);
  const seen: string[] = [];
  for (let i = 0; i < 8 && dir.includes("/"); i++) {
    const hit = aliasCache.get(dir);
    if (hit !== undefined) {
      for (const d of seen) aliasCache.set(d, hit);
      return hit;
    }
    seen.push(dir);
    const cfg = dir + "/tsconfig.json";
    if (await api()?.files.exists(cfg)) {
      const parsed = await readAliases(cfg, dir);
      for (const d of seen) aliasCache.set(d, parsed);
      return parsed;
    }
    dir = dirOf(dir);
  }
  for (const d of seen) aliasCache.set(d, null);
  return null;
}

async function readAliases(
  cfgPath: string,
  dir: string,
): Promise<Aliases | null> {
  try {
    const raw = (await api()?.files.read(cfgPath)) ?? "";
    // tsconfig is JSON with comments and trailing commas in the wild.
    const json = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/,(\s*[}\]])/g, "$1");
    const cfg = JSON.parse(json) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    const opts = cfg.compilerOptions;
    if (!opts?.paths) return null;
    const baseDir = opts.baseUrl ? joinPath(dir, opts.baseUrl) : dir;
    const prefixes: [string, string][] = [];
    for (const [pattern, targets] of Object.entries(opts.paths)) {
      const target = targets[0];
      if (!pattern.endsWith("/*") || !target?.endsWith("/*")) continue;
      prefixes.push([
        pattern.slice(0, -1),
        joinPath(baseDir, target.slice(0, -1)),
      ]);
    }
    return prefixes.length ? { baseDir, prefixes } : null;
  } catch {
    return null;
  }
}

async function resolveSpecifier(
  spec: string,
  fromFile: string,
): Promise<string | null> {
  let base: string | null = null;
  if (spec.startsWith(".")) base = joinPath(dirOf(fromFile), spec);
  else {
    const al = await aliasesFor(fromFile);
    const hit = al?.prefixes.find(([p]) => spec.startsWith(p));
    if (hit) base = joinPath(hit[1], spec.slice(hit[0].length));
  }
  if (!base) return null; // a package: not ours to load
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (!TS_LIKE.test(candidate)) continue;
    if (await api()?.files.exists(candidate)) return candidate;
  }
  return null;
}

// ── models ────────────────────────────────────────────────────────────

/** The model for a path, created if this is the first time it is seen. */
export function modelFor(
  filePath: string,
  text: string,
  language?: string,
): monaco.editor.ITextModel {
  const uri = monaco.Uri.file(toPosix(filePath));
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    if (existing.getValue() !== text) existing.setValue(text);
    return existing;
  }
  return monaco.editor.createModel(text, language, uri);
}

/**
 * Follow a file's imports and load what they point at, breadth first, so the
 * files the user is most likely to ask about arrive first.
 */
export async function loadProjectGraph(
  entryPath: string,
  entryText: string,
): Promise<void> {
  if (!TS_LIKE.test(entryPath)) return;
  let frontier: { path: string; text: string; depth: number }[] = [
    { path: toPosix(entryPath), text: entryText, depth: 0 },
  ];
  loaded.add(toPosix(entryPath));

  while (frontier.length && loaded.size < MAX_FILES) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      if (node.depth >= MAX_DEPTH) continue;
      for (const spec of importSpecifiers(node.text)) {
        if (loaded.size >= MAX_FILES) break;
        const resolved = await resolveSpecifier(spec, node.path);
        if (!resolved || loaded.has(resolved)) continue;
        loaded.add(resolved);
        const text = await api()
          ?.files.read(resolved)
          .catch(() => undefined);
        if (text === undefined) continue;
        modelFor(resolved, text);
        next.push({ path: resolved, text, depth: node.depth + 1 });
      }
    }
    frontier = next;
  }
}

/** How many project files the language service currently holds. */
export function projectModelCount(): number {
  return loaded.size;
}

// ── one-time setup ────────────────────────────────────────────────────

let configured = false;

export function configureMonaco(): void {
  if (configured) return;
  configured = true;

  // LaTeX and friends, before any editor exists: a model picks its language
  // when it is created, and an unregistered extension is plaintext forever.
  registerExtraLanguages();

  // 0.56 moved the language services out of `languages.*` to the top level.
  const ts = monaco.typescript;
  const compilerOptions: monaco.typescript.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    skipLibCheck: true,
    // Off: without node_modules the checker cannot be right, and a wrong
    // checker is worse than none. Completions do not depend on it.
    noResolve: false,
  };
  ts.typescriptDefaults.setCompilerOptions(compilerOptions);
  ts.javascriptDefaults.setCompilerOptions(compilerOptions);
  const diagnostics = { noSemanticValidation: true, noSyntaxValidation: false };
  ts.typescriptDefaults.setDiagnosticsOptions(diagnostics);
  ts.javascriptDefaults.setDiagnosticsOptions(diagnostics);
  ts.typescriptDefaults.setEagerModelSync(true);
  ts.javascriptDefaults.setEagerModelSync(true);

  // Go to Definition can now land in a file that is not open. Opening it as a
  // preview card is what the tree's single click does, so the editor behaves
  // like the rest of the app rather than like a separate program.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const path = resource.fsPath || resource.path;
      if (!path) return false;
      useViewerStore.getState().open(
        {
          name: path.split("/").pop() ?? path,
          path,
          mediaType: "application/octet-stream",
          kind: "file",
          source: "file",
        },
        { preview: true },
      );
      if (selectionOrPosition) pendingReveal.set(toPosix(path), selectionOrPosition);
      return true;
    },
  });
}

/**
 * Where a jump wanted to land. The card mounts after the jump is over, so the
 * position waits here for the editor that is about to be created.
 */
const pendingReveal = new Map<string, monaco.IRange | monaco.IPosition>();

export function takeReveal(
  filePath: string,
): monaco.IRange | monaco.IPosition | undefined {
  const key = toPosix(filePath);
  const hit = pendingReveal.get(key);
  if (hit) pendingReveal.delete(key);
  return hit;
}
