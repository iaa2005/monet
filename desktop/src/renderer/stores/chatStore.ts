/**
 * Chat Store — Zustand store for chat state.
 *
 * Chats run autonomously: the agent runs in the main process per sessionId and
 * streams `chat:token` events tagged with that sessionId. This store keeps a
 * SEPARATE state per session (messages / streaming / usage / error) so a chat
 * you switched away from keeps updating in the background without corrupting
 * the visible one. The top-level `messages`/`isStreaming`/`usage`/`error`
 * fields are a live MIRROR of the current session, so components stay simple.
 */

import { create } from "zustand";
import { useViewerStore } from "./viewerStore";
import { STORAGE_PREFIX } from "@shared/brand";
import type {
  ChatAttachmentMeta,
  ChatMessage,
  LLMEvent,
  SubAgentState,
  ToolCall,
} from "@/types/chat";
import type { BrowserSelection, ElectronAPI } from "@/types/electron";
import { splitSelections } from "@/lib/selection-marks";
import { mergeForSave } from "./merge-for-save";
import { useTaskStore } from "./taskStore";

function electron(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

function generateId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

/** What chat.send wants for each attachment (raw content, not display meta). */
type SendAttachment = NonNullable<
  Parameters<NonNullable<ElectronAPI["chat"]>["send"]>[0]["attachments"]
>[number];

/** Allocates its own ArrayBuffer so the result is a BlobPart: a plain
 * Uint8Array may be backed by a SharedArrayBuffer, which File() rejects. */
function bytesFromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Rebuild composer-ready File objects from a message's saved attachments, for
 * the edit flow. Files with nothing on disk behind them are dropped — a
 * composer entry that cannot be sent is worse than an absent one.
 */
async function restageAttachments(
  metas: ChatAttachmentMeta[] | undefined,
): Promise<StagedAttachment[]> {
  if (!metas?.length) return [];
  const api = electron();
  const out: StagedAttachment[] = [];
  for (const a of metas) {
    if (!a.path) continue;
    try {
      const r = await api?.artifacts.readBytes(a.path);
      if (!r?.ok || !r.base64) continue;
      const file = new File([bytesFromBase64(r.base64)], a.name, {
        type: a.mediaType,
      });
      out.push({
        id: generateId(),
        file,
        url: a.kind === "image" ? URL.createObjectURL(file) : undefined,
      });
    } catch {
      /* skip this one */
    }
  }
  return out;
}

/**
 * Turn the attachments STORED on a message back into a sendable payload.
 *
 * A message keeps only display metadata — name, kind, and where the file was
 * saved. The bytes are re-read from that path, which is why a retry can hand
 * the model the same files instead of quietly resending the turn without them.
 */
async function rebuildAttachments(
  metas: ChatAttachmentMeta[],
): Promise<SendAttachment[]> {
  const api = electron();
  const out: SendAttachment[] = [];
  for (const a of metas) {
    const base = { name: a.name, mediaType: a.mediaType, kind: a.kind };
    try {
      if (a.path && a.kind === "text") {
        const r = await api?.artifacts.readText(a.path);
        if (r?.ok && r.content != null) {
          out.push({ ...base, text: r.content });
          continue;
        }
      } else if (a.path) {
        const r = await api?.artifacts.readBytes(a.path);
        if (r?.ok && r.base64) {
          out.push({ ...base, dataBase64: r.base64 });
          continue;
        }
      }
      // No file on disk (incognito chat, or a message from before attachments
      // were persisted): the in-memory preview is the only copy left.
      const inline = a.dataUrl?.split(",")[1];
      if (inline) {
        out.push({ ...base, dataBase64: inline });
        continue;
      }
    } catch {
      /* fall through to the note below */
    }
    // Say it plainly. The bubble still shows the file, so silently sending a
    // turn without it would leave the model answering about something it was
    // never given.
    out.push({
      name: a.name,
      mediaType: a.mediaType,
      kind: "text",
      text: `\n\n[Attachment ${a.name} could not be re-read, so this retry does not include it.]`,
    });
  }
  return out;
}

/** Apply one sub-agent event to the child's mini-transcript — mirrors the main
 * reducer's text_delta / tool_use / tool_result handling on a nested list, so
 * the child renders with the same components as the top-level chat. */
function reduceSubMessages(
  messages: ChatMessage[],
  event: Extract<LLMEvent, { type: "subagent" }>,
): ChatMessage[] {
  if (event.kind === "text") {
    const msgs = [...messages];
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "assistant" || !last.isStreaming) {
      msgs.push({
        id: generateId(),
        role: "assistant",
        content: event.text ?? "",
        timestamp: Date.now(),
        isStreaming: true,
      });
    } else {
      msgs[msgs.length - 1] = {
        ...last,
        content: last.content + (event.text ?? ""),
      };
    }
    return msgs;
  }
  if (event.kind === "tool") {
    // Freeze any streaming text, drop a stranded empty bubble, add the tool.
    const msgs = messages.map((m) =>
      m.role === "assistant" && m.isStreaming ? { ...m, isStreaming: false } : m,
    );
    const last = msgs[msgs.length - 1];
    if (last && last.role === "assistant" && !last.content) msgs.pop();
    msgs.push({
      id: generateId(),
      role: "tool",
      content: `Tool: ${event.name ?? "tool"}`,
      timestamp: Date.now(),
      toolCall: {
        id: event.childId ?? generateId(),
        name: event.name ?? "tool",
        input: event.input ?? {},
        status: "running",
      },
    });
    return msgs;
  }
  if (event.kind === "tool_done") {
    return messages.map((m) =>
      m.toolCall && m.toolCall.id === event.childId
        ? {
            ...m,
            toolCall: {
              ...m.toolCall,
              status: event.isError ? ("error" as const) : ("done" as const),
              output: event.output,
            },
          }
        : m,
    );
  }
  return messages;
}

export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
}

/** A file picked in the composer and waiting to be sent. `url` is an object
 * URL for image previews — whoever drops the entry revokes it. */
export interface StagedAttachment {
  id: string;
  file: File;
  url?: string;
}

interface SessionState {
  messages: ChatMessage[];
  isStreaming: boolean;
  usage: ChatUsage | null;
  error: string | null;
  /** Messages queued while streaming — sent automatically when the run ends. */
  queue: ChatMessage[];
  /**
   * True once this buffer is known to hold the session's WHOLE history — it
   * was loaded from the DB, or the chat was started in this renderer.
   *
   * Saving replaces every row for the session, so a buffer that only holds
   * part of the history would delete the rest. That is not hypothetical: the
   * agent runs in the main process and keeps streaming across a renderer
   * reload, so after one the store is empty while `chat:token` events are
   * still arriving. Without this flag the reducer builds a fresh buffer out of
   * those events alone and the next save wipes everything that came before.
   */
  hydrated: boolean;
}

const EMPTY: SessionState = {
  messages: [],
  isStreaming: false,
  usage: null,
  error: null,
  queue: [],
  hydrated: false,
};

export const INTERRUPT_MARK = "\n\n⏹️ Generation interrupted.";

/**
 * Finalize all messages and stamp a visible "Stopped" badge on the turn that
 * was actually interrupted.
 *
 * The badge used to land on the PREVIOUS answer. Stopping a turn before it had
 * emitted any text leaves an empty assistant message; the filter below removes
 * it, and the old search for "the last assistant message anywhere" then walked
 * straight past the user's prompt into the turn before it — so a reply that had
 * finished normally, sometimes minutes earlier and above the user's own new
 * message, was the one wearing "Stopped".
 *
 * The search now stops at the prompt that opened this turn. If this turn
 * produced nothing, the note stands on its own instead of defacing an older
 * answer.
 */
export function markInterrupted(msgs: ChatMessage[]): ChatMessage[] {
  const out = msgs
    .filter((m) => !(m.role === "assistant" && !m.content))
    .map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m));

  let idx = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    // The prompt that opened this turn. Anything above it belongs to a turn
    // that already ended, and must not be touched.
    if (out[i]!.role === "user") break;
    if (out[i]!.role === "assistant" && out[i]!.content) {
      idx = i;
      break;
    }
  }

  if (idx >= 0) {
    if (out[idx]!.content.endsWith(INTERRUPT_MARK)) return out;
    return out.map((m, i) =>
      i === idx ? { ...m, content: m.content + INTERRUPT_MARK } : m,
    );
  }

  // Stopped before this turn said anything — mid-tools, or right away. The note
  // carries INTERRUPT_MARK itself so it renders as the same "Stopped" badge:
  // spelled out as plain prose it was missing the marker's leading blank line,
  // so the badge check never matched and it showed as literal text.
  return [
    ...out,
    {
      id: generateId(),
      role: "assistant" as const,
      content: INTERRUPT_MARK,
      timestamp: Date.now(),
    },
  ];
}

interface ChatStore {
  // Per-session state (keyed by sessionId).
  sessions: Record<string, SessionState>;

  // Visible mirror of the current session.
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  usage: ChatUsage | null;

  currentSessionId?: string;
  /** Bumped whenever sessions change, so the sidebar reloads. */
  sessionsVersion: number;
  /** Bumped when the effective working directory changes (e.g. a chat with
   * its own saved folder was opened) so WorkspacePicker refreshes. */
  workspaceVersion: number;
  /** Incognito: the conversation is kept in memory only — never written to the
   * session DB, never shown in Recents. */
  incognito: boolean;
  /** Text to push into the composer (e.g. a Home suggestion chip). Consumed
   * and cleared by MessageInput. */
  composerDraft: string;
  /** Unsent composer text PER CHAT (and per space for the blank chat), so
   * switching chats and coming back restores what you were typing.
   * Keys: sessionId, or "new:<space>" for a fresh chat. */
  drafts: Record<string, string>;
  /** Attachments staged in the composer but not sent yet, PER CHAT, under the
   * same keys as `drafts`. They used to be component state, which survives a
   * chat switch — so files picked in one chat followed you into the next and
   * got sent there. Held in memory only (File objects don't serialise). */
  stagedFiles: Record<string, StagedAttachment[]>;
  /** Elements picked in the Browser panel's design mode, waiting to be sent.
   * Not per-chat like drafts: you point at something and then decide which
   * chat to ask in, and losing the selection on that switch is infuriating. */
  pendingContext: BrowserSelection[];
  /** Files dropped onto the chat window, waiting for the composer to stage
   * them as attachments (consumed and cleared by MessageInput). */
  droppedFiles: File[] | null;
  /** A file the user asked to open in the in-app viewer (tool file links).
   * Consumed and cleared by App. */
  openFileRequest: string | null;
  /** Request to open the Changes tab in the right panel. Consumed by App. */
  openChangesRequest: boolean;
  /** Open Settings at a section (the panel menu's "Manage allowed sites"). */
  openSettingsRequest: string | null;
  /** Branch the chat from this user message. Consumed by App, which owns
   * session switching. */
  forkRequest: string | null;

  /** Sub-agent expanded to fill the chat area (like FileViewer). */
  expandedSubAgent: SubAgentState | null;
  /** Current workspace ("home" | "code") — new chats are tagged with it so
   * Home and Code keep separate Recents. Mirrors App's appMode. */
  space: string;

  /** Any session currently streaming (used to show a running indicator in the
   * sidebar). */
  isSessionStreaming: (id: string) => boolean;

  setCurrentSessionId: (id?: string) => void;
  setIncognito: (v: boolean) => void;
  setComposerDraft: (v: string) => void;
  setDraft: (key: string, text: string) => void;
  setStagedFiles: (
    key: string,
    update: StagedAttachment[] | ((prev: StagedAttachment[]) => StagedAttachment[]),
  ) => void;
  setDroppedFiles: (files: File[] | null) => void;
  addPendingContext: (sel: BrowserSelection) => void;
  clearPendingContext: () => void;
  requestOpenFile: (path: string | null) => void;
  requestOpenChanges: () => void;
  requestOpenSettings: (section: string | null) => void;
  requestFork: (messageId: string | null) => void;
  /** Hand a sent message back to the composer: sentence as text, references as
   * chips, files re-staged under `stagedKey`. Rewind-and-edit and Branch. */
  stageMessageForComposer: (
    message: ChatMessage,
    stagedKey: string,
  ) => Promise<void>;
  openViewer: (
    item: {
      name: string;
      path?: string;
      mediaType: string;
      kind: string;
      dataUrl?: string;
      source?: "artifact" | "file";
    } | null,
    /** `preview: false` pins the card — a double click rather than a click. */
    opts?: { preview?: boolean },
  ) => void;
  openExpandedSubAgent: (sa: SubAgentState | null) => void;
  setSpace: (v: string) => void;
  bumpSessions: () => void;
  bumpWorkspace: () => void;
  /** Seed a session's message list (e.g. loaded from the DB). Does NOT clobber
   * a session that's currently streaming in the background. */
  loadSessionMessages: (id: string, messages: ChatMessage[]) => void;
  addUserMessage: (
    content: string,
    attachments?: ChatAttachmentMeta[],
  ) => ChatMessage;
  startStreaming: () => void;
  finishStreaming: (usage?: ChatUsage) => void;
  setError: (error: string) => void;
  clearMessages: () => void;
  /** Route a streamed event to its session (main tags each event). */
  handleLLMEvent: (sessionId: string, event: LLMEvent) => void;
  /** Rewind the conversation to a user message and re-run it (Edit/Retry):
   * truncate to before it, reset the main-process history, and resend the
   * (optionally edited) text. */
  resendFrom: (messageId: string, newText?: string) => Promise<void>;
  /** Code Rewind: restore the workspace to a message's checkpoint (shadow git)
   * and truncate the conversation to and including that message. */
  rewindTo: (messageId: string) => Promise<void>;
  /** Code Rewind (under a user message): restore the workspace to the state
   * BEFORE this turn, truncate the conversation to before it, and drop the
   * user's prompt back into the composer for editing + resend. */
  rewindAndEdit: (messageId: string) => Promise<void>;
  /** Auto-continue: a background sub-agent finished while the chat is idle —
   * kick off a turn that delivers its queued report to the model. */
  deliverBackgroundResults: () => Promise<void>;
  /** Queue a message to be sent when the current run finishes. */
  enqueueMessage: (sessionId: string, content: string) => void;
  /** Remove a message from the queue (cancel a pending queued send). */
  dequeueMessage: (sessionId: string, messageId: string) => void;
  /** Per-session queue (visible mirror of current session's queue). */
  queue: ChatMessage[];
}

interface SessionsBridge {
  sessions?: {
    getById: (id: string) => Promise<unknown>;
    save: (session: unknown) => Promise<void>;
  };
}

function sessionsApi(): SessionsBridge["sessions"] {
  return (window as unknown as { electronAPI?: SessionsBridge }).electronAPI
    ?.sessions;
}

export const useChatStore = create<ChatStore>((set, get) => {
  /**
   * Persist a session's buffer to the DB when its run ends.
   *
   * This runs on message_stop/error from the SAME ordered chat:token stream
   * as the text deltas, so the snapshot provably contains every delta sent
   * before the stop. Saving after `chat.send()` resolves (the old way, in
   * MessageInput) races the tail of that stream — the invoke reply travels a
   * different IPC path than webContents.send and can overtake the last few
   * token events, clipping the end of long replies (observed: adapter emitted
   * 12303 chars, the DB copy had 12294).
   */
  async function persistSession(sessionId: string): Promise<void> {
    const api = sessionsApi();
    if (!api) return;
    const msgs = get().sessions[sessionId]?.messages ?? [];
    if (msgs.length === 0) return;
    try {
      // Keep a user-chosen title (Rename); auto-title fresh sessions from the
      // first user message.
      const existing = (await api.getById(sessionId)) as
        | { title?: string; space?: string; messages?: ChatMessage[] }
        | null
        | undefined;
      // If the row is gone the session was deleted (e.g. skipped routine) — a
      // late-arriving async persist must not revive it.
      if (!existing) return;
      const derived =
        msgs.find((m) => m.role === "user")?.content?.slice(0, 60) ??
        "New Session";
      const title =
        existing.title && existing.title !== "New Session"
          ? existing.title
          : derived;
      // Preserve the chat's space from the DB row (set at create()); only fall
      // back to the current visible space if the row doesn't exist yet. Using
      // the DB value keeps a Home chat that persists while a Code chat is on
      // screen (background run) from being reclassified.
      const space = existing.space ?? get().space;
      // Re-read the buffer AFTER the awaits — more deltas may have landed.
      const live = get().sessions[sessionId];
      const latest = live?.messages ?? msgs;

      // save() replaces every row, so a buffer holding only part of the chat
      // would delete the rest — see mergeForSave for the reload that did it.
      const toSave = mergeForSave(
        latest,
        live?.hydrated === true,
        existing?.messages,
      );
      mutate(sessionId, (p) => ({ ...p, messages: toSave, hydrated: true }));

      await api.save({ id: sessionId, title, messages: toSave, space });
      get().bumpSessions();
    } catch {
      /* offline / DB unavailable — keep the in-memory buffer */
    }
  }

  /** Pop the first queued message and send it as a new turn. */
  async function sendQueuedMessage(sessionId: string): Promise<void> {
    const st = get();
    const session = st.sessions[sessionId];
    if (!session || session.isStreaming || session.queue.length === 0) return;
    const msg = session.queue[0];
    // Remove from queue and add to messages.
    mutate(sessionId, (p) => ({
      ...p,
      queue: p.queue.slice(1),
      messages: [...p.messages, msg],
    }));
    // Persist the updated messages.
    void persistSession(sessionId);
    // Send via the same path as chat:send.
    const bridge = electron();
    if (!bridge) return;
    const seed = (get().sessions[sessionId]?.messages ?? [])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .filter((m) => m.content)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    get().startStreaming();
    const mode =
      st.space === "home"
        ? "default"
        : localStorage.getItem("permission-mode") ?? "default";
    try {
      await bridge.chat.send({
        sessionId,
        message: msg.content,
        seed,
        mode,
        space: st.space,
      });
    } catch {
      /* best-effort */
    }
  }

  // ─── Delta batching ───────────────────────────────────────────────────
  // A long reply arrives as thousands of tiny text_delta IPC events. Applying
  // each one individually re-renders the whole chat (and re-parses the
  // streamed markdown every time) — that's what froze the UI during
  // generation: sluggish text, laggy scrolling, unclickable Stop, slow chat
  // switching. Buffer text per session and flush at most every FLUSH_MS.
  const FLUSH_MS = 50;
  const pendingText = new Map<string, string>();
  const pendingReasoning = new Map<string, string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Throttle for mid-run checkpoint saves (per session). */
  const lastCheckpoint = new Map<string, number>();

  function flushPendingFor(sessionId: string): void {
    // Reasoning is emitted before the visible answer, so flush it first to keep
    // ordering (thinking then text) intact.
    const reasoning = pendingReasoning.get(sessionId);
    if (reasoning) {
      pendingReasoning.delete(sessionId);
      mutate(sessionId, (p) => reduce(p, { type: "reasoning_delta", text: reasoning }));
    }
    const text = pendingText.get(sessionId);
    if (text) {
      pendingText.delete(sessionId);
      mutate(sessionId, (p) => reduce(p, { type: "text_delta", text }));
    }
  }

  function flushAllPending(): void {
    const ids = new Set([...pendingText.keys(), ...pendingReasoning.keys()]);
    for (const id of ids) flushPendingFor(id);
  }

  /** Update one session's state; mirror to the visible fields if it's current. */
  function mutate(
    sessionId: string,
    fn: (prev: SessionState) => SessionState,
  ): void {
    set((s) => {
      const prev = s.sessions[sessionId] ?? EMPTY;
      const next = fn(prev);
      const sessions = { ...s.sessions, [sessionId]: next };
      if (sessionId === s.currentSessionId) {
        return {
          sessions,
          messages: next.messages,
          isStreaming: next.isStreaming,
          usage: next.usage,
          error: next.error,
          queue: next.queue,
        };
      }
      return { sessions };
    });
  }

  function targetId(): string {
    return get().currentSessionId ?? "default";
  }

  /** Apply a stream event to a session's message list (pure-ish reducer). */
  function reduce(prev: SessionState, event: LLMEvent): SessionState {
    switch (event.type) {
      case "text_delta": {
        const msgs = [...prev.messages];
        const last = msgs[msgs.length - 1];
        if (!last || last.role !== "assistant" || !last.isStreaming) {
          msgs.push({
            id: generateId(),
            role: "assistant",
            content: event.text,
            timestamp: Date.now(),
            isStreaming: true,
          });
        } else {
          msgs[msgs.length - 1] = {
            ...last,
            content: last.content + event.text,
          };
        }
        return { ...prev, messages: msgs, isStreaming: true, error: null };
      }
      case "reasoning_delta": {
        // Thinking tokens attach to the current streaming assistant message
        // (created here if the answer text hasn't started yet). Display-only.
        const msgs = [...prev.messages];
        const last = msgs[msgs.length - 1];
        if (!last || last.role !== "assistant" || !last.isStreaming) {
          msgs.push({
            id: generateId(),
            role: "assistant",
            content: "",
            reasoning: event.text,
            timestamp: Date.now(),
            isStreaming: true,
          });
        } else {
          msgs[msgs.length - 1] = {
            ...last,
            reasoning: (last.reasoning ?? "") + event.text,
          };
        }
        return { ...prev, messages: msgs, isStreaming: true, error: null };
      }
      case "user_message": {
        const msgs = [
          ...prev.messages,
          {
            id: generateId(),
            role: "user" as const,
            content: event.content,
            timestamp: Date.now(),
          },
        ];
        return { ...prev, messages: msgs };
      }
      case "tool_use": {
        const msgs = [...prev.messages];
        // Drop a trailing empty assistant bubble so it can't get stranded.
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant" && !last.content) msgs.pop();
        msgs.push({
          id: generateId(),
          role: "tool",
          content: `Tool: ${event.name}`,
          timestamp: Date.now(),
          toolCall: {
            id: event.id,
            name: event.name,
            input: event.input,
            status: "pending",
          },
        });
        return { ...prev, messages: msgs, isStreaming: true };
      }
      case "tool_result": {
        const running = event.content === "Running...";
        const msgs = prev.messages.map((m) =>
          m.toolCall?.id === event.toolUseID
            ? {
                ...m,
                toolCall: {
                  ...m.toolCall,
                  status: running ? ("running" as const) : ("done" as const),
                  ...(running ? {} : { output: event.content }),
                },
              }
            : m,
        );
        return { ...prev, messages: msgs };
      }
      case "checkpoint": {
        // Attach the workspace snapshot to the turn's final assistant message
        // so its "Rewind to here" can restore that state.
        const msgs = [...prev.messages];
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "assistant") {
            msgs[i] = { ...msgs[i], checkpointSha: event.sha };
            break;
          }
        }
        return { ...prev, messages: msgs };
      }
      case "subagent": {
        // Live sub-agent state lives on the launching Task tool call. The
        // child's activity is a real mini-transcript (assistant text + tool
        // calls) so it renders with the SAME components as the main chat.
        const msgs = prev.messages.map((m) => {
          if (m.toolCall?.id !== event.toolUseID) return m;
          const tc = m.toolCall;
          const sa: SubAgentState = tc.subAgent ?? {
            agentType: "agent",
            status: "running",
            messages: [],
          };
          let next: SubAgentState = sa;
          if (event.kind === "start") {
            next = {
              ...sa,
              agentType: event.agentType ?? sa.agentType,
              description: event.description ?? sa.description,
              background: event.background ?? sa.background,
              status: "running",
            };
          } else if (event.kind === "done") {
            next = {
              ...sa,
              status: "done",
              messages: sa.messages.map((cm) =>
                cm.isStreaming ? { ...cm, isStreaming: false } : cm,
              ),
            };
          } else {
            next = { ...sa, messages: reduceSubMessages(sa.messages, event) };
          }
          return { ...m, toolCall: { ...tc, subAgent: next } };
        });
        return { ...prev, messages: msgs };
      }
      case "message_stop": {
        if (event.stop_reason === "abort") {
          return {
            ...prev,
            messages: markInterrupted(prev.messages),
            isStreaming: false,
            usage: event.usage ?? prev.usage,
          };
        }
        // The provider cut the reply at its output limit — say so instead of
        // silently showing a message that ends mid-sentence.
        const truncated = event.stop_reason === "max_tokens";
        const messages = prev.messages
          .filter((m) => !(m.role === "assistant" && !m.content))
          .map((m) => {
            if (!m.isStreaming) return m;
            const content =
              truncated && m.role === "assistant" && m.content
                ? `${m.content}\n\n> ⚠️ Response truncated — the provider's max_tokens output limit was reached.`
                : m.content;
            return { ...m, isStreaming: false, content };
          });
        return {
          ...prev,
          messages,
          isStreaming: false,
          usage: event.usage ?? prev.usage,
        };
      }
      case "error": {
        // A user-initiated Stop is not an error — mark the chat interrupted
        // instead of flashing a red box.
        if (event.error === "Aborted") {
          return {
            ...prev,
            messages: markInterrupted(prev.messages),
            isStreaming: false,
          };
        }
        const messages = prev.messages
          .filter((m) => !(m.role === "assistant" && !m.content))
          .map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m));
        return { ...prev, messages, isStreaming: false, error: event.error };
      }
      default:
        return prev;
    }
  }

  return {
    sessions: {},
    messages: [],
    isStreaming: false,
    error: null,
    usage: null,
    currentSessionId: undefined,
    sessionsVersion: 0,
    workspaceVersion: 0,
    incognito: false,
    composerDraft: "",
    drafts: {},
    stagedFiles: {},
    pendingContext: [],
    droppedFiles: null,
    openFileRequest: null,
    openChangesRequest: false,
    openSettingsRequest: null,
    forkRequest: null,
    expandedSubAgent: null,
    space: "home",
    queue: [],

    isSessionStreaming: (id) => get().sessions[id]?.isStreaming ?? false,

    setCurrentSessionId: (id) => {
      set((s) => {
        const cur = (id && s.sessions[id]) || EMPTY;
        return {
          currentSessionId: id,
          messages: cur.messages,
          isStreaming: cur.isStreaming,
          usage: cur.usage,
          error: cur.error,
          queue: cur.queue,
        };
      });
    },

    setIncognito: (v) => set({ incognito: v }),
    setComposerDraft: (v) => set({ composerDraft: v }),
    setDraft: (key, text) =>
      set((s) => ({ drafts: { ...s.drafts, [key]: text } })),
    setStagedFiles: (key, update) =>
      set((s) => {
        const prev = s.stagedFiles[key] ?? [];
        const next = typeof update === "function" ? update(prev) : update;
        // Drop the key entirely when empty so the map doesn't grow one dead
        // entry per chat the user ever opened.
        if (next.length === 0) {
          if (!(key in s.stagedFiles)) return {};
          const rest = { ...s.stagedFiles };
          delete rest[key];
          return { stagedFiles: rest };
        }
        return { stagedFiles: { ...s.stagedFiles, [key]: next } };
      }),
    setDroppedFiles: (files) => set({ droppedFiles: files }),
    addPendingContext: (sel) =>
      set((s) => ({ pendingContext: [...s.pendingContext, sel] })),
    clearPendingContext: () => set({ pendingContext: [] }),
    requestOpenFile: (path) => set({ openFileRequest: path }),
    requestOpenChanges: () => set({ openChangesRequest: true }),
    requestOpenSettings: (section) => set({ openSettingsRequest: section }),
    requestFork: (messageId) => set({ forkRequest: messageId }),
    // Facade over viewerStore (tabs + VS Code preview idiom): every "open a
    // file" click in the app lands here, whatever surface it came from.
    openViewer: (item, opts) => {
      if (item) {
        useViewerStore.getState().open(item, opts);
        set({ expandedSubAgent: null });
      } else {
        useViewerStore.getState().closeAll();
      }
    },
    openExpandedSubAgent: (sa) => {
      if (sa) useViewerStore.getState().closeAll();
      set({ expandedSubAgent: sa });
    },
    setSpace: (v) => set({ space: v }),
    bumpSessions: () =>
      set((s) => ({ sessionsVersion: s.sessionsVersion + 1 })),
    bumpWorkspace: () =>
      set((s) => ({ workspaceVersion: s.workspaceVersion + 1 })),

    loadSessionMessages: (id, messages) => {
      const existing = get().sessions[id];
      // Keep a live (streaming) background session as-is.
      if (existing?.isStreaming) {
        get().setCurrentSessionId(id);
        return;
      }
      // Don't clobber in-memory messages that haven't been persisted yet
      // (e.g. a routine chat that's still accumulating events in the
      // background but isn't streaming-flagged because message_stop hasn't
      // arrived). If the DB has fewer messages than what we already have,
      // keep the richer in-memory state.
      if (existing && existing.messages.length > messages.length) {
        get().setCurrentSessionId(id);
        return;
      }
      pendingText.delete(id);
      // The DB copy IS the whole history, so this buffer is now safe to save
      // wholesale — see SessionState.hydrated.
      mutate(id, () => ({ ...EMPTY, messages, hydrated: true }));
    },

    addUserMessage: (content, attachments) => {
      const msg: ChatMessage = {
        id: generateId(),
        role: "user",
        content,
        timestamp: Date.now(),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      };
      mutate(targetId(), (p) => ({
        ...p,
        messages: [...p.messages, msg],
        error: null,
      }));
      return msg;
    },

    startStreaming: () =>
      mutate(targetId(), (p) => ({ ...p, isStreaming: true, error: null })),

    finishStreaming: (usage) =>
      mutate(targetId(), (p) =>
        reduce(p, { type: "message_stop", stop_reason: "end_turn", usage }),
      ),

    setError: (error) =>
      mutate(targetId(), (p) => reduce(p, { type: "error", error })),

    clearMessages: () => {
      const id = get().currentSessionId;
      if (id) {
        pendingText.delete(id);
        mutate(id, () => ({ ...EMPTY }));
      } else {
        set({ messages: [], isStreaming: false, usage: null, error: null });
      }
    },

    resendFrom: async (messageId, newText) => {
      const state = get();
      const sessionId = state.currentSessionId;
      if (!sessionId || state.isStreaming) return;
      const msgs = state.messages;
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx < 0 || msgs[idx].role !== "user") return;
      const text = (newText ?? msgs[idx].content).trim();
      // An attachment-only turn is legitimate ("look at this"), so the guard
      // is on having SOMETHING to send, not on having text.
      const carried = msgs[idx].attachments;
      if (!text && !carried?.length) return;

      // Truncate the renderer to the history strictly BEFORE the target user
      // message; the main-process durable transcript is truncated to the same
      // point (keeping tool blocks) so the resend continues with full fidelity.
      // `seed` is the text fallback for chats with no durable transcript.
      const prior = msgs.slice(0, idx);
      const seed = prior
        .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      const keepUserTurns = prior.filter((m) => m.role === "user").length;
      const totalUserTurns = msgs.filter((m) => m.role === "user").length;

      mutate(sessionId, (p) => ({
        ...p,
        messages: prior,
        isStreaming: false,
        error: null,
      }));
      const bridge = electron();
      await bridge?.chat.rewindTranscript(
        sessionId,
        keepUserTurns,
        totalUserTurns,
      );
      // Re-read the files BEFORE the turn starts: if a read fails we still
      // send, but the note about it has to be in the payload from the start.
      const attachments = carried?.length
        ? await rebuildAttachments(carried)
        : undefined;

      get().addUserMessage(text, carried);
      get().startStreaming();
      const eff = localStorage.getItem(`${STORAGE_PREFIX}effort`);
      const effort =
        eff === "low" || eff === "medium" || eff === "high" ? eff : undefined;
      await bridge?.chat.send({
        sessionId,
        message: text,
        seed,
        space: state.space,
        effort,
        attachments,
      });
    },

    rewindTo: async (messageId) => {
      const state = get();
      const sessionId = state.currentSessionId;
      if (!sessionId || state.isStreaming) return;
      const msgs = state.messages;
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx < 0) return;

      const bridge = electron();
      const sha = msgs[idx].checkpointSha;
      if (sha) {
        const r = await bridge?.checkpoints.rewind(sessionId, sha);
        if (r && !r.ok) {
          mutate(sessionId, (p) => ({
            ...p,
            error: r.error ?? "Rewind failed.",
          }));
          return;
        }
      }
      // Truncate to and including this message; truncate the durable transcript
      // to the same user-turn count so the next send continues from here.
      const kept = msgs.slice(0, idx + 1);
      const keepUserTurns = kept.filter((m) => m.role === "user").length;
      const totalUserTurns = msgs.filter((m) => m.role === "user").length;
      mutate(sessionId, (p) => ({
        ...p,
        messages: kept,
        isStreaming: false,
        error: null,
      }));
      await bridge?.chat.rewindTranscript(
        sessionId,
        keepUserTurns,
        totalUserTurns,
      );
      // Write the truncation down NOW. A send would persist it as a side
      // effect, but a rewind is complete without one — leave the DB unsaved
      // and reopening the chat brings back everything just removed, which
      // reads as the rewind never having happened.
      await persistSession(sessionId);
    },

    stageMessageForComposer: async (message, stagedKey) => {
      // The sentence goes into the box; the machine-collected element blocks
      // do not. Every path that hands a sent message back for editing has to
      // make this split — Rewind learned it first, then Branch shipped without
      // it and the raw <selected-from-browser> text was back in the composer.
      const bridge = electron();
      const { text, refs } = splitSelections(message.content);

      // The turn's files come back too, minus the crops: those belong to the
      // chips, not to the attachment row.
      const metas = message.attachments ?? [];
      const crops = metas.filter((a) => a.origin === "selection");
      const restaged = await restageAttachments(
        metas.filter((a) => a.origin !== "selection"),
      );
      get().setStagedFiles(stagedKey, restaged);

      // References return as references. Their ⟨tokens⟩ are already in the
      // restored text, so they are pretokenised — inserting again would double
      // every chip. Crop dataUrls only exist in the session that made them;
      // after a reload there is just the artifact path, so read it back or the
      // re-sent message silently goes out without the pictures.
      const cropUrls = await Promise.all(
        refs.map(async (_r, i) => {
          const crop = crops[i];
          if (crop?.dataUrl) return crop.dataUrl;
          if (!crop?.path) return undefined;
          try {
            const r = await bridge?.artifacts.readBytes(crop.path);
            return r?.ok && r.base64
              ? `data:${crop.mediaType || "image/png"};base64,${r.base64}`
              : undefined;
          } catch {
            return undefined;
          }
        }),
      );
      set({
        pendingContext: refs.map((r, i) => ({
          id: generateId(),
          label: r.label,
          count: 1,
          // Keep the colour the message recorded; the index is only a
          // fallback for blocks written before the tag carried a tone.
          tone: r.tone ?? i,
          pretokenised: true,
          context: r.raw,
          imageDataUrl: cropUrls[i],
          url: r.url,
        })),
      });
      get().setComposerDraft(text);
    },

    rewindAndEdit: async (messageId) => {
      const state = get();
      const sessionId = state.currentSessionId;
      if (!sessionId || state.isStreaming) return;
      const msgs = state.messages;
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx < 0 || msgs[idx].role !== "user") return;
      const bridge = electron();

      // Restore files to the checkpoint from BEFORE this turn — the most recent
      // assistant checkpoint before this user message (undefined if it's the
      // first turn, which has no prior snapshot: then we only truncate + edit).
      let sha: string | undefined;
      for (let i = idx - 1; i >= 0; i--) {
        if (msgs[i].checkpointSha) {
          sha = msgs[i].checkpointSha;
          break;
        }
      }
      if (sha) {
        const r = await bridge?.checkpoints.rewind(sessionId, sha);
        if (r && !r.ok) {
          mutate(sessionId, (p) => ({
            ...p,
            error: r.error ?? "Rewind failed.",
          }));
          return;
        }
      }

      // Truncate to BEFORE this user message, truncate the durable transcript
      // to the same user-turn count (tool blocks kept) so the next send
      // continues with full fidelity, and drop the prompt into the composer.
      const prior = msgs.slice(0, idx);
      const keepUserTurns = prior.filter((m) => m.role === "user").length;
      const totalUserTurns = msgs.filter((m) => m.role === "user").length;
      mutate(sessionId, (p) => ({
        ...p,
        messages: prior,
        isStreaming: false,
        error: null,
      }));
      await bridge?.chat.rewindTranscript(
        sessionId,
        keepUserTurns,
        totalUserTurns,
      );
      // Same as rewindTo: the truncation is real only once it is in the DB.
      // This path drops the prompt into the composer, and deciding not to
      // resend it is a legitimate way to use it — the rewind must hold anyway.
      await persistSession(sessionId);
      await get().stageMessageForComposer(msgs[idx], sessionId);
    },

    deliverBackgroundResults: async () => {
      const state = get();
      const sessionId = state.currentSessionId;
      // Only auto-continue the currently-open chat, and only when idle — a
      // running turn will fold the queued report in on its own.
      if (!sessionId || state.isStreaming) return;
      const bridge = electron();
      if (!bridge) return;
      const seed = state.messages
        .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      get().startStreaming();
      // Home only understands approve/skip; elsewhere honour the saved mode.
      const mode =
        state.space === "home"
          ? "default"
          : localStorage.getItem("permission-mode") ?? "default";
      try {
        // Empty message: the main process folds the queued background report(s)
        // into this turn, so the model responds to the result with no visible
        // user bubble.
        await bridge.chat.send({
          sessionId,
          message: "",
          seed,
          mode,
          space: state.space,
        });
      } catch {
        /* best-effort auto-continue */
      }
    },

    enqueueMessage: (sessionId, content) => {
      const msg: ChatMessage = {
        id: generateId(),
        role: "user",
        content,
        timestamp: Date.now(),
      };
      mutate(sessionId, (p) => ({
        ...p,
        queue: [...p.queue, msg],
      }));
    },

    dequeueMessage: (sessionId, messageId) => {
      mutate(sessionId, (p) => ({
        ...p,
        queue: p.queue.filter((m) => m.id !== messageId),
      }));
    },

    handleLLMEvent: (sessionId, event) => {
      // Coalesce the text firehose (see the batching note above).
      if (event.type === "text_delta" || event.type === "reasoning_delta") {
        const buf = event.type === "text_delta" ? pendingText : pendingReasoning;
        buf.set(sessionId, (buf.get(sessionId) ?? "") + event.text);
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            flushAllPending();
          }, FLUSH_MS);
        }
        return;
      }
      // Any other event: apply this session's buffered text FIRST so ordering
      // within the session is preserved (tool rows, stops, errors).
      flushPendingFor(sessionId);
      mutate(sessionId, (p) => reduce(p, event));

      // Mirror tool activity into the task registry (Background tasks panel).
      // Same ordered stream, so an entry opens on the call and closes on its
      // result; a run that ends with calls still open settles them rather than
      // leaving them spinning.
      const tasks = useTaskStore.getState();
      if (event.type === "tool_use")
        tasks.startTask(sessionId, event.id, event.name, event.input ?? {});
      // Only the FINAL result closes a row. A tool emits this event three ways
      // — a placeholder before it runs, progress while it runs, and the result
      // — and closing on the first stamped every task "Completed 0s" with the
      // word "Running…" as its output, then ignored the real result because the
      // row was no longer running.
      else if (event.type === "tool_result" && event.final)
        tasks.finishTask(
          event.toolUseID,
          event.content ?? "",
          /^(error|Error:)/.test(event.content ?? ""),
        );
      else if (event.type === "message_stop" || event.type === "error")
        tasks.settleSession(sessionId);

      // A background sub-agent finishing while its chat is open and idle
      // auto-continues the turn so the model receives its report.
      if (
        event.type === "subagent" &&
        event.kind === "done" &&
        sessionId === get().currentSessionId
      ) {
        const st = get();
        const card = st.messages.find((m) => m.toolCall?.id === event.toolUseID);
        if (card?.toolCall?.subAgent?.background && !st.isStreaming) {
          void get().deliverBackgroundResults();
        }
      }

      const persistable =
        sessionId && sessionId !== "default" && !sessionId.startsWith("incognito-");
      // End of run → persist this session (ordered with the deltas above).
      if (
        persistable &&
        (event.type === "message_stop" ||
          event.type === "error" ||
          event.type === "checkpoint")
      ) {
        lastCheckpoint.delete(sessionId);
        void persistSession(sessionId);
      }
      // Checkpoint on tool results (throttled) so a chat killed mid-run —
      // app closed, crash — keeps everything up to the last completed tool.
      if (persistable && event.type === "tool_result") {
        const now = Date.now();
        if (now - (lastCheckpoint.get(sessionId) ?? 0) > 3000) {
          lastCheckpoint.set(sessionId, now);
          void persistSession(sessionId);
        }
      }

      // After a run ends, send the next queued message (if any).
      if (
        (event.type === "message_stop" || event.type === "error") &&
        !get().sessions[sessionId]?.isStreaming &&
        get().sessions[sessionId]?.queue?.length
      ) {
        void sendQueuedMessage(sessionId);
      }
    },
  };
});

/**
 * Test seam — see the note in dock-store.ts.
 *
 * The dev server, and any harness that loads the BUILT renderer without the
 * preload bridge (scripts/dock-click-probe.cjs). Never the real app: there,
 * contextBridge has published electronAPI before this module evaluates.
 */
// `typeof window` first: node probes import this module for its constants,
// and both halves of the condition below reach for browser globals.
if (
  typeof window !== "undefined" &&
  (import.meta.env.DEV || !(window as { electronAPI?: unknown }).electronAPI)
)
  (window as unknown as { __monetChat?: unknown }).__monetChat = useChatStore;
