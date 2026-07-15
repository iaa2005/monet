/**
 * Minimal LSP manager (desktop-native).
 *
 * Spawns a language server per (workspace, language) on first use, speaks
 * LSP over stdio via vscode-jsonrpc, and answers a few high-value queries
 * (definition, references, hover, document symbols, diagnostics). Servers are
 * kept warm for the process and reused. Self-contained: no vendor deps.
 *
 * The server binaries are NOT bundled — the user must have them installed
 * (typescript-language-server, pyright, gopls, rust-analyzer, clangd). A file
 * whose language has no resolvable server returns a clear message.
 */

import { type ChildProcess, execFileSync, spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { extname, join } from "path";
import { pathToFileURL } from "url";
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

interface ServerDef {
  id: string;
  /** Bare command (resolved against node_modules/.bin then PATH). */
  command: string;
  args: string[];
  languageId: string;
}

/** Extension → language server. Extend freely; unknown extensions are rejected. */
const SERVERS: Record<string, ServerDef> = {
  ".ts": { id: "tsserver", command: "typescript-language-server", args: ["--stdio"], languageId: "typescript" },
  ".tsx": { id: "tsserver", command: "typescript-language-server", args: ["--stdio"], languageId: "typescriptreact" },
  ".js": { id: "tsserver", command: "typescript-language-server", args: ["--stdio"], languageId: "javascript" },
  ".jsx": { id: "tsserver", command: "typescript-language-server", args: ["--stdio"], languageId: "javascriptreact" },
  ".mjs": { id: "tsserver", command: "typescript-language-server", args: ["--stdio"], languageId: "javascript" },
  ".cjs": { id: "tsserver", command: "typescript-language-server", args: ["--stdio"], languageId: "javascript" },
  ".py": { id: "pyright", command: "pyright-langserver", args: ["--stdio"], languageId: "python" },
  ".pyi": { id: "pyright", command: "pyright-langserver", args: ["--stdio"], languageId: "python" },
  ".go": { id: "gopls", command: "gopls", args: [], languageId: "go" },
  ".rs": { id: "rust-analyzer", command: "rust-analyzer", args: [], languageId: "rust" },
  ".c": { id: "clangd", command: "clangd", args: [], languageId: "c" },
  ".h": { id: "clangd", command: "clangd", args: [], languageId: "c" },
  ".cpp": { id: "clangd", command: "clangd", args: [], languageId: "cpp" },
  ".hpp": { id: "clangd", command: "clangd", args: [], languageId: "cpp" },
  ".cc": { id: "clangd", command: "clangd", args: [], languageId: "cpp" },
};

export function serverForFile(file: string): ServerDef | null {
  return SERVERS[extname(file).toLowerCase()] ?? null;
}

/** Launch a `.cmd`/`.bat` shim through cmd.exe (native `.exe` is spawned as-is,
 * so its stdio pipes cleanly — wrapping an exe in cmd breaks LSP framing). */
function viaShim(file: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file))
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", file, ...args] };
  return { command: file, args };
}

/**
 * Resolve a server command to a spawnable executable. Prefers the workspace's
 * node_modules/.bin; otherwise resolves the real binary from PATH (via `where`
 * on Windows so a native `.exe` is spawned directly, not through cmd).
 */
function resolveSpawn(
  root: string,
  command: string,
  args: string[],
): { command: string; args: string[] } {
  const win = process.platform === "win32";
  const binDir = join(root, "node_modules", ".bin");
  const localCmd = join(binDir, win ? `${command}.cmd` : command);
  if (existsSync(localCmd)) return viaShim(localCmd, args);
  if (!win) return { command, args }; // POSIX: spawn resolves PATH natively
  try {
    const found = execFileSync("where", [command], { encoding: "utf-8" })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (found) return viaShim(found, args);
  } catch {
    /* not on PATH — let spawn ENOENT with a clean message */
  }
  return { command, args };
}

interface Server {
  conn: MessageConnection;
  proc: ChildProcess;
  initialized: Promise<void>;
  opened: Map<string, number>; // uri → version
  diagnostics: Map<string, unknown[]>; // uri → Diagnostic[]
}

const servers = new Map<string, Server>();
const START_TIMEOUT_MS = 20_000;

function key(root: string, id: string): string {
  return `${root}::${id}`;
}

async function getServer(root: string, def: ServerDef): Promise<Server> {
  const k = key(root, def.id);
  const existing = servers.get(k);
  if (existing) {
    await existing.initialized;
    return existing;
  }

  const { command, args } = resolveSpawn(root, def.command, def.args);
  const proc = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: root,
    windowsHide: true,
  });

  // Keep the tail of stderr so a server that dies (e.g. a rustup shim whose
  // component isn't installed) reports its real error, not a bare timeout.
  let stderrTail = "";
  proc.stderr?.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });
  const stderrHint = (): string => {
    const t = stderrTail.trim();
    return t ? `: ${t.split(/\r?\n/).slice(-3).join(" | ")}` : "";
  };

  const conn = createMessageConnection(
    new StreamMessageReader(proc.stdout!),
    new StreamMessageWriter(proc.stdin!),
  );
  const diagnostics = new Map<string, unknown[]>();
  conn.onNotification(
    "textDocument/publishDiagnostics",
    (p: { uri: string; diagnostics: unknown[] }) => {
      if (p && typeof p.uri === "string")
        diagnostics.set(p.uri, p.diagnostics ?? []);
    },
  );
  conn.onError(() => {});
  conn.listen();

  const server: Server = {
    conn,
    proc,
    opened: new Map(),
    diagnostics,
    initialized: Promise.resolve(),
  };

  server.initialized = (async () => {
    // spawn errors (ENOENT) surface asynchronously — surface a clean message.
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error): void => {
        proc.removeListener("spawn", onOk);
        reject(e);
      };
      const onOk = (): void => {
        proc.removeListener("error", onErr);
        resolve();
      };
      proc.once("spawn", onOk);
      proc.once("error", onErr);
    });
    // If the server dies during the handshake, fail fast with its stderr
    // instead of waiting out the whole timeout.
    const exited = new Promise<never>((_r, reject) => {
      proc.once("exit", (code) =>
        reject(new Error(`server exited (code ${code})${stderrHint()}`)),
      );
    });
    const initialize = conn.sendRequest("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(root).toString(),
      workspaceFolders: [
        { uri: pathToFileURL(root).toString(), name: "workspace" },
      ],
      capabilities: {
        textDocument: {
          synchronization: { didSave: false, dynamicRegistration: false },
          hover: { contentFormat: ["plaintext", "markdown"] },
          definition: {},
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: {},
        },
        workspace: { workspaceFolders: true },
      },
    });
    await Promise.race([
      initialize,
      exited,
      new Promise((_r, rej) =>
        setTimeout(
          () => rej(new Error(`initialize timed out${stderrHint()}`)),
          START_TIMEOUT_MS,
        ),
      ),
    ]);
    await conn.sendNotification("initialized", {});
  })();

  servers.set(k, server);
  try {
    await server.initialized;
  } catch (err) {
    servers.delete(k);
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    throw err;
  }
  return server;
}

function uriOf(file: string): string {
  return pathToFileURL(file).toString();
}

/** Ensure the file is open on the server (didOpen once, per uri). */
async function ensureOpen(server: Server, file: string, languageId: string): Promise<string> {
  const uri = uriOf(file);
  if (!server.opened.has(uri)) {
    const text = readFileSync(file, "utf-8");
    server.opened.set(uri, 1);
    await server.conn.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }
  return uri;
}

export type LspOperation =
  | "goToDefinition"
  | "findReferences"
  | "hover"
  | "documentSymbol"
  | "diagnostics";

export interface LspQuery {
  operation: LspOperation;
  root: string;
  file: string;
  /** 1-based (editor style); converted to LSP 0-based internally. */
  line?: number;
  character?: number;
}

export async function lspQuery(q: LspQuery): Promise<string> {
  const def = serverForFile(q.file);
  if (!def)
    return `No language server configured for ${extname(q.file) || "this file type"}.`;
  if (!existsSync(q.file)) return `File not found: ${q.file}`;

  let server: Server;
  try {
    server = await getServer(q.root, def);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Could not start ${def.command} (${def.id}). Is it installed and on PATH? ${msg}`;
  }

  const uri = await ensureOpen(server, q.file, def.languageId);
  const pos =
    q.line != null && q.character != null
      ? { line: Math.max(0, q.line - 1), character: Math.max(0, q.character - 1) }
      : undefined;

  if (q.operation === "diagnostics") {
    // Diagnostics arrive as a push after didOpen; give the server a moment.
    await new Promise((r) => setTimeout(r, 1200));
    return formatDiagnostics(server.diagnostics.get(uri) ?? []);
  }

  if (!pos && q.operation !== "documentSymbol")
    return `Operation ${q.operation} requires line and character.`;

  try {
    if (q.operation === "goToDefinition") {
      const res = await server.conn.sendRequest("textDocument/definition", {
        textDocument: { uri },
        position: pos,
      });
      return formatLocations(res, "definition");
    }
    if (q.operation === "findReferences") {
      const res = await server.conn.sendRequest("textDocument/references", {
        textDocument: { uri },
        position: pos,
        context: { includeDeclaration: true },
      });
      return formatLocations(res, "reference");
    }
    if (q.operation === "hover") {
      const res = (await server.conn.sendRequest("textDocument/hover", {
        textDocument: { uri },
        position: pos,
      })) as { contents?: unknown } | null;
      return formatHover(res);
    }
    // documentSymbol
    const res = await server.conn.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    });
    return formatSymbols(res);
  } catch (err) {
    return `LSP request failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Formatting ────────────────────────────────────────────────────────────

function fileUriToPath(uri: string): string {
  try {
    return decodeURIComponent(uri.replace(/^file:\/\/\/?/, process.platform === "win32" ? "" : "/"));
  } catch {
    return uri;
  }
}

function loc(l: { uri: string; range: { start: { line: number; character: number } } }): string {
  return `${fileUriToPath(l.uri)}:${l.range.start.line + 1}:${l.range.start.character + 1}`;
}

function formatLocations(res: unknown, label: string): string {
  const arr = (Array.isArray(res) ? res : res ? [res] : []) as {
    uri: string;
    range: { start: { line: number; character: number } };
  }[];
  if (arr.length === 0) return `No ${label} found.`;
  return `${arr.length} ${label}(s):\n` + arr.map((l) => `- ${loc(l)}`).join("\n");
}

function formatHover(res: { contents?: unknown } | null): string {
  if (!res || !res.contents) return "No hover information.";
  const c = res.contents;
  const text =
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.map((x) => (typeof x === "string" ? x : (x as { value?: string }).value ?? "")).join("\n")
        : (c as { value?: string }).value ?? "";
  return text.trim() || "No hover information.";
}

function formatSymbols(res: unknown): string {
  const arr = (Array.isArray(res) ? res : []) as {
    name: string;
    kind: number;
    range?: { start: { line: number } };
    location?: { range: { start: { line: number } } };
    children?: unknown[];
  }[];
  if (arr.length === 0) return "No symbols found.";
  const lines: string[] = [];
  const walk = (
    items: typeof arr,
    depth: number,
  ): void => {
    for (const s of items) {
      const line =
        (s.range?.start.line ?? s.location?.range.start.line ?? 0) + 1;
      lines.push(`${"  ".repeat(depth)}- ${s.name} (${SYMBOL_KIND[s.kind] ?? s.kind}) :${line}`);
      if (Array.isArray(s.children) && s.children.length)
        walk(s.children as typeof arr, depth + 1);
    }
  };
  walk(arr, 0);
  return lines.join("\n");
}

function formatDiagnostics(diags: unknown[]): string {
  if (diags.length === 0) return "No diagnostics.";
  const sev: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };
  return diags
    .map((d) => {
      const x = d as {
        severity?: number;
        message: string;
        range: { start: { line: number; character: number } };
      };
      return `- [${sev[x.severity ?? 1] ?? "info"}] ${x.range.start.line + 1}:${x.range.start.character + 1} ${x.message}`;
    })
    .join("\n");
}

const SYMBOL_KIND: Record<number, string> = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method",
  7: "property", 8: "field", 9: "constructor", 10: "enum", 11: "interface",
  12: "function", 13: "variable", 14: "constant", 15: "string", 16: "number",
  17: "boolean", 18: "array", 19: "object", 20: "key", 21: "null",
  22: "enumMember", 23: "struct", 24: "event", 25: "operator", 26: "typeParameter",
};

/** Shut every server down (app quit / cleanup). */
export async function stopAllLsp(): Promise<void> {
  for (const [k, s] of servers) {
    try {
      await s.conn.sendRequest("shutdown", {});
      await s.conn.sendNotification("exit", {});
    } catch {
      /* ignore */
    }
    try {
      s.conn.dispose();
      s.proc.kill();
    } catch {
      /* ignore */
    }
    servers.delete(k);
  }
}
