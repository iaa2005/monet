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
import { getProfilePrompt } from "../profile.js";
import { buildMemoryPrompt } from "../memory/store.js";
import { loadClaudeMd } from "../claude-md.js";
import { getWorkspacePath } from "./workspace.js";
import {
  loadTranscriptWithMeta,
  replaceTranscript,
} from "../transcript-store.js";
import type { LLMMessage } from "../llm/adapter.js";

const BUNDLE_FORMAT = "monet-chat";
const BUNDLE_VERSION = 2;
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
  };
  messages: ChatMessage[];
  /** The durable model transcript (tool_use/tool_result blocks) + hidden flags,
   * so an imported chat continues with the SAME context, not a text-only
   * rebuild. Absent in v1 bundles / chats without a transcript. */
  transcript?: { messages: LLMMessage[]; hidden: boolean[] };
  artifacts?: BundleArtifact[];
  context?: { profile?: string; memory?: string; claudeMd?: string };
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

/** Read the session's artifact files (newest-per-name), embedded as base64. */
function collectArtifacts(sessionId: string): BundleArtifact[] {
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
          const bundle: Bundle = {
            format: BUNDLE_FORMAT,
            version: BUNDLE_VERSION,
            exportedAt: new Date().toISOString(),
            app: "monet",
            session: {
              title: session.title,
              space: session.space,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
            },
            messages: session.messages,
            // The full model transcript — so the recipient continues with the
            // exact context (tool blocks), not a text-only rebuild. Only when
            // the chat actually has one (new chats do; migrated ones are text).
            ...(() => {
              const t = loadTranscriptWithMeta(sessionId);
              return t.messages.length > 0 ? { transcript: t } : {};
            })(),
            ...(opts.includeArtifacts
              ? { artifacts: collectArtifacts(sessionId) }
              : {}),
            ...(opts.includeContext ? { context: sysContext() } : {}),
          };
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
        if (bundle.format !== BUNDLE_FORMAT || !Array.isArray(bundle.messages))
          return { ok: false, error: "Not a Monet chat bundle." };

        const created = store.create(
          bundle.session?.title || "Imported chat",
          bundle.session?.space || "code",
        );

        // Materialise embedded files into the new session's artifacts, and map
        // basename → new path so attachment previews/opens work post-import.
        const pathByName = new Map<string, string>();
        for (const a of bundle.artifacts ?? []) {
          try {
            const bytes = Buffer.from(a.base64, "base64");
            pathByName.set(a.name, saveArtifactBuffer(created.id, a.name, bytes));
          } catch {
            /* skip bad artifact */
          }
        }

        // Message ids are a global PK — regenerate them, and remap attachment
        // paths onto the freshly written artifacts.
        const messages: ChatMessage[] = bundle.messages.map((m) => ({
          ...m,
          id: randomUUID(),
          attachments: m.attachments?.map((att) => {
            const name = att.name ? basename(att.name) : att.name;
            const p = name ? pathByName.get(name) : undefined;
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

        // Restore the durable model transcript so the imported chat continues
        // with full fidelity (tool blocks). Absent → it self-migrates to
        // text-only on first continuation, like any pre-transcript chat.
        if (
          bundle.transcript &&
          Array.isArray(bundle.transcript.messages) &&
          bundle.transcript.messages.length > 0
        ) {
          replaceTranscript(
            created.id,
            bundle.transcript.messages,
            bundle.transcript.hidden,
          );
        }

        return { ok: true, session: store.get(created.id) ?? undefined };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
