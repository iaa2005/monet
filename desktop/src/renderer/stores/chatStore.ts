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
import type {
  ChatAttachmentMeta,
  ChatMessage,
  LLMEvent,
  SubAgentState,
  ToolCall,
} from "@/types/chat";
import type { ElectronAPI } from "@/types/electron";

function electron(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

function generateId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
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
}

const EMPTY: SessionState = {
  messages: [],
  isStreaming: false,
  usage: null,
  error: null,
  queue: [],
};

export const INTERRUPT_MARK = "\n\n⏹️ Generation interrupted.";

/** Finalize all messages and stamp a visible "interrupted" note at the end —
 * a stopped chat should say so instead of looking like a finished answer. */
function markInterrupted(msgs: ChatMessage[]): ChatMessage[] {
  const out = msgs
    .filter((m) => !(m.role === "assistant" && !m.content))
    .map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m));
  const last = [...out].reverse().find((m) => m.role === "assistant");
  if (last?.content && !last.content.endsWith(INTERRUPT_MARK)) {
    return out.map((m) =>
      m === last ? { ...m, content: m.content + INTERRUPT_MARK } : m,
    );
  }
  if (!last) {
    // Aborted before any text (e.g. mid-tools) — add a standalone note.
    out.push({
      id: generateId(),
      role: "assistant",
      content: "⏹️ Generation interrupted.",
      timestamp: Date.now(),
    });
  }
  return out;
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
  /** Files dropped onto the chat window, waiting for the composer to stage
   * them as attachments (consumed and cleared by MessageInput). */
  droppedFiles: File[] | null;
  /** A file the user asked to open in the in-app viewer (tool file links).
   * Consumed and cleared by App. */
  openFileRequest: string | null;
  /** Request to open the Changes tab in the right panel. Consumed by App. */
  openChangesRequest: boolean;
  /** Unified file/artifact viewer state (null = closed).
   * source "artifact" → reads via artifacts:* IPC, pass as item prop.
   * source "file" → reads via files:* IPC, pass as path prop. */
  viewer: {
    name: string;
    path?: string;
    mediaType: string;
    kind: string;
    dataUrl?: string;
    source?: "artifact" | "file";
  } | null;
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
  requestOpenFile: (path: string | null) => void;
  requestOpenChanges: () => void;
  openViewer: (
    item: {
      name: string;
      path?: string;
      mediaType: string;
      kind: string;
      dataUrl?: string;
      source?: "artifact" | "file";
    } | null,
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
        | { title?: string; space?: string }
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
      const latest = get().sessions[sessionId]?.messages ?? msgs;
      await api.save({ id: sessionId, title, messages: latest, space });
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
    droppedFiles: null,
    openFileRequest: null,
    openChangesRequest: false,
    viewer: null,
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
    requestOpenFile: (path) => set({ openFileRequest: path }),
    requestOpenChanges: () => set({ openChangesRequest: true }),
    openViewer: (item) =>
      set({ viewer: item, ...(item ? { expandedSubAgent: null } : {}) }),
    openExpandedSubAgent: (sa) =>
      set({ expandedSubAgent: sa, ...(sa ? { viewer: null } : {}) }),
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
      mutate(id, () => ({ ...EMPTY, messages }));
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
      if (!text) return;

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
      get().addUserMessage(text);
      get().startStreaming();
      const eff = localStorage.getItem("monet.effort");
      const effort =
        eff === "low" || eff === "medium" || eff === "high" ? eff : undefined;
      await bridge?.chat.send({
        sessionId,
        message: text,
        seed,
        space: state.space,
        effort,
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
    },

    rewindAndEdit: async (messageId) => {
      const state = get();
      const sessionId = state.currentSessionId;
      if (!sessionId || state.isStreaming) return;
      const msgs = state.messages;
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx < 0 || msgs[idx].role !== "user") return;
      const text = msgs[idx].content;
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
      get().setComposerDraft(text);
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
