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
import type { ChatMessage, LLMEvent, ToolCall } from "@/types/chat";

function generateId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
}

interface SessionState {
  messages: ChatMessage[];
  isStreaming: boolean;
  usage: ChatUsage | null;
  error: string | null;
}

const EMPTY: SessionState = {
  messages: [],
  isStreaming: false,
  usage: null,
  error: null,
};

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
  /** Incognito: the conversation is kept in memory only — never written to the
   * session DB, never shown in Recents. */
  incognito: boolean;
  /** Text to push into the composer (e.g. a Home suggestion chip). Consumed
   * and cleared by MessageInput. */
  composerDraft: string;
  /** Current workspace ("home" | "code") — new chats are tagged with it so
   * Home and Code keep separate Recents. Mirrors App's appMode. */
  space: string;

  /** Any session currently streaming (used to show a running indicator in the
   * sidebar). */
  isSessionStreaming: (id: string) => boolean;

  setCurrentSessionId: (id?: string) => void;
  setIncognito: (v: boolean) => void;
  setComposerDraft: (v: string) => void;
  setSpace: (v: string) => void;
  bumpSessions: () => void;
  /** Seed a session's message list (e.g. loaded from the DB). Does NOT clobber
   * a session that's currently streaming in the background. */
  loadSessionMessages: (id: string, messages: ChatMessage[]) => void;
  addUserMessage: (content: string) => ChatMessage;
  startStreaming: () => void;
  finishStreaming: (usage?: ChatUsage) => void;
  setError: (error: string) => void;
  clearMessages: () => void;
  /** Route a streamed event to its session (main tags each event). */
  handleLLMEvent: (sessionId: string, event: LLMEvent) => void;
}

export const useChatStore = create<ChatStore>((set, get) => {
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
      case "message_stop": {
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
    incognito: false,
    composerDraft: "",
    space: "home",

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
        };
      });
    },

    setIncognito: (v) => set({ incognito: v }),
    setComposerDraft: (v) => set({ composerDraft: v }),
    setSpace: (v) => set({ space: v }),
    bumpSessions: () =>
      set((s) => ({ sessionsVersion: s.sessionsVersion + 1 })),

    loadSessionMessages: (id, messages) => {
      const existing = get().sessions[id];
      // Keep a live (streaming) background session as-is.
      if (existing?.isStreaming) {
        get().setCurrentSessionId(id);
        return;
      }
      mutate(id, () => ({ ...EMPTY, messages }));
    },

    addUserMessage: (content) => {
      const msg: ChatMessage = {
        id: generateId(),
        role: "user",
        content,
        timestamp: Date.now(),
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
      if (id) mutate(id, () => ({ ...EMPTY }));
      else set({ messages: [], isStreaming: false, usage: null, error: null });
    },

    handleLLMEvent: (sessionId, event) => {
      mutate(sessionId, (p) => reduce(p, event));
    },
  };
});
