/**
 * Chat transfer IPC — export a full chat (transcript + tool I/O + files) to a
 * file, and import a Monet bundle back into a new session.
 *
 * Two formats:
 *  - Monet bundle (.monet.json): full fidelity — session meta, every message
 *    with its tool calls (input + output), attachment metadata, and the
 *    produced/attached files embedded as base64. Re-importable into Monet to
 *    continue the chat; the model-facing context is reconstructed from the
 *    messages on open, exactly like reopening any saved chat.
 *  - Markdown (.md): a human/AI-readable transcript for handing to a person or
 *    a different agent. Binary files can't be embedded, so they're listed.
 *
 * Optional: the user's Profile + long-term Memory + project CLAUDE.md ("system
 * context"). OFF by default — sharing a chat shouldn't leak personal context.
 *
 * A v3 bundle also carries the state AROUND the chat: its flags (pinned,
 * archived), the routine that produced it, the folder it was bound to (as a
 * PATH — restored only if that path exists here), its desk (dock layout and
 * browser tabs), its goal, and its context-event log so "undo compact" still
 * works after an import.
 *
 * What a bundle deliberately does NOT carry: the project folder of a Code chat
 * (that is the user's repository, not the conversation), and therefore the
 * shadow-git checkpoints, which are that folder's file history under another
 * name. An imported Code chat continues the conversation; it does not
 * resurrect a workspace.
 */

import { dialog, ipcMain } from "electron";
import { basename, join } from "path";
import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { randomUUID } from "node:crypto";
import {
  getSessionStore,
  type ChatMessage,
  type SessionWithMessages,
} from "../session-store.js";
import { artifactSessionDir, saveArtifactBuffer } from "./artifacts.js";
import { mediaTypeOf } from "../sandbox/index.js";
import { listSandboxFiles, copyBufferIntoSandbox } from "../sandbox/files.js";
import { getProfilePrompt } from "../profile.js";
import { buildMemoryPrompt } from "../memory/store.js";
import { loadClaudeMd } from "../claude-md.js";
import { getWorkspacePath } from "./workspace.js";
import {
  listContextEvents,
  loadTranscriptWithMeta,
  replaceContextEvents,
  replaceTranscript,
  type ContextEvent,
} from "../transcript-store.js";
import { getUiState, setUiState, type SessionUiState } from "../ui-state.js";
import { loadGoal, saveGoal } from "../agent/goal/store.js";
import type { Goal } from "../agent/goal/state.js";
import { existsSync } from "fs";
import type { LLMMessage } from "../llm/adapter.js";

const BUNDLE_FORMAT = "monet-chat";
const BUNDLE_VERSION = 3;
const MAX_ARTIFACT_FILE = 20 * 1024 * 1024; // 20 MB per file
const MAX_ARTIFACT_TOTAL = 60 * 1024 * 1024; // 60 MB total

export interface ExportOptions {
  format: "monet" | "markdown";
  includeArtifacts: boolean;
  includeContext: boolean;
  /** Markdown only: dump full, untruncated tool inputs + outputs (raw). Off by
   * default (compact one-line tool calls) — on gives another agent full fidelity. */
  includeRawTools?: boolean;
}

interface BundleArtifact {
  name: string;
  mediaType: string;
  base64: string;
}

/** A file from the Home sandbox work tree, at its relative path (subfolders
 * preserved) — restored into the imported chat's sandbox so RunPython /
 * SandboxRead and the Files tab see it. */
interface BundleSandboxFile {
  path: string;
  mediaType: string;
  base64: string;
}

interface Bundle {
  format: typeof BUNDLE_FORMAT;
  version: number;
  exportedAt: string;
  app: "monet";
  session: {
    title: string;
    space?: string;
    createdAt?: string;
    updatedAt?: string;
    /** v3: the chat's own flags. */
    pinned?: boolean;
    archived?: boolean;
    /** v3: the routine that produced this chat, if any. */
    routineId?: string;
    /** v3: the folder it was bound to. A PATH, not its contents — restored
     * only when it exists on the importing machine. */
    workspace?: string;
  };
  messages: ChatMessage[];
  /** The durable model transcript (tool_use/tool_result blocks) + hidden flags,
   * so an imported chat continues with the SAME context, not a text-only
   * rebuild. Absent in v1 bundles / chats without a transcript. */
  transcript?: { messages: LLMMessage[]; hidden: boolean[] };
  artifacts?: BundleArtifact[];
  /** The Home sandbox work tree (subfolders preserved). */
  sandboxFiles?: BundleSandboxFile[];
  context?: { profile?: string; memory?: string; claudeMd?: string };
  /** v3: the desk — which panels were open, which pages the browser held. */
  uiState?: SessionUiState;
  /** v3: the goal this chat was pursuing. */
  goal?: Goal;
  /** v3: compact / rewind history, so "undo compact" survives the trip. */
  contextEvents?: ContextEvent[];
}

function sysContext(): { profile?: string; memory?: string; claudeMd?: string } {
  const profile = getProfilePrompt() ?? undefined;
  const memory = buildMemoryPrompt() ?? undefined;
  let claudeMd: string | undefined;
  try {
    claudeMd = loadClaudeMd(getWorkspacePath()) ?? undefined;
  } catch {
    /* ignore */
  }
  return { profile, memory, claudeMd };
}

/** The Home sandbox work tree (recursive, subfolders preserved) as base64.
 * Empty for Code chats / chats that produced no sandbox files. */
function collectSandboxFiles(sessionId: string): BundleSandboxFile[] {
  const out: BundleSandboxFile[] = [];
  let total = 0;
  for (const f of listSandboxFiles(sessionId)) {
    if (f.size > MAX_ARTIFACT_FILE || total + f.size > MAX_ARTIFACT_TOTAL) continue;
    try {
      out.push({
        path: f.name,
        mediaType: mediaTypeOf(f.name),
        base64: readFileSync(f.path).toString("base64"),
      });
      total += f.size;
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/** Read the session's artifact files (newest-per-name), embedded as base64.
 * `skip` basenames already carried by the sandbox tree are omitted (dedup). */
function collectArtifacts(sessionId: string, skip?: Set<string>): BundleArtifact[] {
  const dir = artifactSessionDir(sessionId);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const newest = new Map<string, { ts: number; full: string }>();
  for (const f of entries) {
    const m = /^(\d+)-(.+)$/.exec(f);
    const name = m ? m[2] : f;
    const ts = m ? Number(m[1]) : 0;
    const full = join(dir, f);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    const cur = newest.get(name);
    if (!cur || ts > cur.ts) newest.set(name, { ts, full });
  }
  const out: BundleArtifact[] = [];
  let total = 0;
  for (const [name, { full }] of newest) {
    if (skip?.has(name)) continue; // already exported in the sandbox tree
    let size: number;
    try {
      size = statSync(full).size;
    } catch {
      continue;
    }
    if (size > MAX_ARTIFACT_FILE || total + size > MAX_ARTIFACT_TOTAL) continue;
    try {
      out.push({
        name,
        mediaType: mediaTypeOf(name),
        base64: readFileSync(full).toString("base64"),
      });
      total += size;
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

function toMarkdown(session: SessionWithMessages, opts: ExportOptions): string {
  const lines: string[] = [];
  lines.push(`# ${session.title || "Chat"}`);
  lines.push(
    `*Exported from Monet · ${session.space ?? "code"} · ${new Date().toISOString()} · ${session.messages.length} messages*`,
  );
  lines.push("");

  if (opts.includeContext) {
    const c = sysContext();
    const parts = [c.profile, c.memory, c.claudeMd].filter(Boolean);
    if (parts.length) {
      lines.push("## System context");
      lines.push("");
      lines.push("```");
      lines.push(parts.join("\n\n"));
      lines.push("```");
      lines.push("");
    }
  }

  lines.push("---");
  for (const m of session.messages) {
    lines.push("");
    if (m.role === "user") lines.push("## 🧑 User");
    else if (m.role === "assistant") lines.push("## 🤖 Assistant");
    else lines.push(`## ${m.role}`);
    if (m.content?.trim()) lines.push(m.content.trim());
    if (m.attachments?.length)
      lines.push(
        `\n**📎 Attachments:** ${m.attachments.map((a) => a.name).join(", ")}`,
      );
    if (m.toolCall) {
      const t = m.toolCall;
      let input = "";
      try {
        input = JSON.stringify(t.input, null, opts.includeRawTools ? 2 : 0);
      } catch {
        input = "{…}";
      }
      if (opts.includeRawTools) {
        // Full raw fidelity for another agent: untruncated input + output.
        lines.push(`\n**🔧 Tool: ${t.name}**`);
        lines.push("```json");
        lines.push(input);
        lines.push("```");
        if (t.output) {
          lines.push("Output:");
          lines.push("```");
          lines.push(t.output);
          lines.push("```");
        }
      } else {
        // Compact: name + short input, no output — keeps the transcript light.
        lines.push(`\n**🔧 ${t.name}** \`${input.slice(0, 120)}\``);
      }
    }
  }
  return lines.join("\n");
}

function safeFileBase(title: string): string {
  return (
    (title || "chat")
      .replace(/[^\p{L}\p{N} _-]+/gu, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "chat"
  );
}

/**
 * Everything a chat is, as a bundle. Separated from the IPC handler so a probe
 * can round-trip it without a file dialog.
 */
export function buildBundle(
  sessionId: string,
  opts: ExportOptions,
): Bundle | null {
  const store = getSessionStore();
  const session = store.get(sessionId);
  if (!session) return null;

  const uiState = getUiState(sessionId);
  const goal = loadGoal(sessionId);
  const contextEvents = listContextEvents(sessionId);

  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    app: "monet",
    session: {
      title: session.title,
      space: session.space,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.pinned ? { pinned: true } : {}),
      ...(session.archived ? { archived: true } : {}),
      ...(store.routineIdOf(sessionId)
        ? { routineId: store.routineIdOf(sessionId) }
        : {}),
      // The PATH only. The folder itself is the user's project, and a chat is
      // not a way to ship a repository.
      ...(session.workspace ? { workspace: session.workspace } : {}),
    },
    messages: session.messages,
    // The full model transcript — so the recipient continues with the exact
    // context (tool blocks), not a text-only rebuild. Only when the chat
    // actually has one (new chats do; migrated ones are text).
    ...(() => {
      const t = loadTranscriptWithMeta(sessionId);
      return t.messages.length > 0 ? { transcript: t } : {};
    })(),
    ...(() => {
      if (!opts.includeArtifacts) return {};
      // Sandbox work tree (structured) is canonical; artifacts (flat) cover
      // attachments/preview — dedup the Home overlap by basename.
      const sandboxFiles = collectSandboxFiles(sessionId);
      const skip = new Set(sandboxFiles.map((f) => basename(f.path)));
      const artifacts = collectArtifacts(sessionId, skip);
      return {
        ...(sandboxFiles.length ? { sandboxFiles } : {}),
        ...(artifacts.length ? { artifacts } : {}),
      };
    })(),
    ...(opts.includeContext ? { context: sysContext() } : {}),
    // The state around the chat: its desk, its goal, its context history.
    ...(uiState ? { uiState } : {}),
    ...(goal ? { goal } : {}),
    ...(contextEvents.length ? { contextEvents } : {}),
  };
}

/**
 * A bundle becomes a new chat.
 *
 * New id, new message ids (they are a global primary key), embedded files
 * written into this install's artifact/sandbox folders and the attachment
 * paths remapped onto them.
 */
export function applyBundle(bundle: Partial<Bundle>): SessionWithMessages | null {
  const store = getSessionStore();
  if (bundle.format !== BUNDLE_FORMAT || !Array.isArray(bundle.messages))
    return null;

  const created = store.create(
    bundle.session?.title || "Imported chat",
    bundle.session?.space || "code",
  );

  // Materialise embedded files, mapping BOTH the relative path and the
  // basename to the new artifact path: two files called data.csv in different
  // sandbox folders used to collapse into one attachment.
  const byPath = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const sf of bundle.sandboxFiles ?? []) {
    try {
      const bytes = Buffer.from(sf.base64, "base64");
      copyBufferIntoSandbox(created.id, sf.path, bytes);
      const base = basename(sf.path);
      const artifact = saveArtifactBuffer(created.id, base, bytes);
      byPath.set(sf.path, artifact);
      if (!byName.has(base)) byName.set(base, artifact);
    } catch {
      /* skip bad sandbox file */
    }
  }
  for (const a of bundle.artifacts ?? []) {
    try {
      const bytes = Buffer.from(a.base64, "base64");
      const artifact = saveArtifactBuffer(created.id, a.name, bytes);
      byPath.set(a.name, artifact);
      if (!byName.has(a.name)) byName.set(a.name, artifact);
    } catch {
      /* skip bad artifact */
    }
  }

  const messages: ChatMessage[] = bundle.messages.map((m) => ({
    ...m,
    id: randomUUID(),
    attachments: m.attachments?.map((att) => {
      const p =
        (att.name ? byPath.get(att.name) : undefined) ??
        (att.name ? byName.get(basename(att.name)) : undefined);
      return p ? { ...att, path: p } : { ...att, path: undefined };
    }),
  }));

  store.save({
    id: created.id,
    title: created.title,
    space: bundle.session?.space || "code",
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
    messageCount: messages.length,
    messages,
  });

  // The chat's own flags.
  if (bundle.session?.pinned) store.setPinned(created.id, true);
  if (bundle.session?.archived) store.setArchived(created.id, true);
  if (bundle.session?.routineId)
    store.markRoutineChat(created.id, bundle.session.routineId);
  // A path from another machine usually means nothing here; binding the chat
  // to a folder that does not exist would send its next turn somewhere wrong.
  if (bundle.session?.workspace && existsSync(bundle.session.workspace))
    store.setWorkspace(created.id, bundle.session.workspace);

  // Restore the durable model transcript so the imported chat continues with
  // full fidelity (tool blocks). Absent → it self-migrates to text-only on
  // first continuation, like any pre-transcript chat.
  if (
    bundle.transcript &&
    Array.isArray(bundle.transcript.messages) &&
    bundle.transcript.messages.length > 0
  )
    replaceTranscript(
      created.id,
      bundle.transcript.messages,
      bundle.transcript.hidden,
    );

  // The state around the chat.
  if (bundle.uiState) setUiState(created.id, bundle.uiState);
  if (bundle.goal) saveGoal(created.id, bundle.goal);
  if (bundle.contextEvents?.length)
    replaceContextEvents(
      created.id,
      bundle.contextEvents.map((ev) => ({ ...ev, sessionId: created.id })),
    );

  return store.get(created.id) ?? null;
}

export function registerTransferIPC(): void {
  const store = getSessionStore();

  ipcMain.handle(
    "chat:export",
    async (
      _e,
      sessionId: string,
      opts: ExportOptions,
    ): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> => {
      const session = store.get(sessionId);
      if (!session) return { ok: false, error: "Session not found" };

      const ext = opts.format === "markdown" ? "md" : "monet.json";
      const picked = await dialog.showSaveDialog({
        title: "Export chat",
        defaultPath: `${safeFileBase(session.title)}.${ext}`,
        filters:
          opts.format === "markdown"
            ? [{ name: "Markdown", extensions: ["md"] }]
            : [{ name: "Monet chat", extensions: ["monet.json", "json"] }],
      });
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };

      try {
        if (opts.format === "markdown") {
          writeFileSync(picked.filePath, toMarkdown(session, opts), "utf-8");
        } else {
          const bundle = buildBundle(sessionId, opts);
          if (!bundle) return { ok: false, error: "Session not found" };
          writeFileSync(picked.filePath, JSON.stringify(bundle, null, 2), "utf-8");
        }
        return { ok: true, path: picked.filePath };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    "chat:import",
    async (): Promise<{
      ok: boolean;
      canceled?: boolean;
      error?: string;
      session?: SessionWithMessages;
    }> => {
      const picked = await dialog.showOpenDialog({
        title: "Import chat",
        properties: ["openFile"],
        filters: [{ name: "Monet chat", extensions: ["monet.json", "json"] }],
      });
      if (picked.canceled || picked.filePaths.length === 0)
        return { ok: false, canceled: true };

      try {
        const raw = readFileSync(picked.filePaths[0], "utf-8");
        const bundle = JSON.parse(raw) as Partial<Bundle>;
        const session = applyBundle(bundle);
        if (!session) return { ok: false, error: "Not a Monet chat bundle." };
        return { ok: true, session };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
