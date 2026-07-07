/**
 * Chat Store — Zustand store for chat state.
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

interface ChatStore {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  currentSessionId?: string;
  usage: ChatUsage | null;
  /** Bumped whenever sessions change, so the sidebar reloads. */
  sessionsVersion: number;

  setCurrentSessionId: (id?: string) => void;
  bumpSessions: () => void;
  addUserMessage: (content: string) => ChatMessage;
  addAssistantMessage: () => ChatMessage;
  appendToLastMessage: (text: string) => void;
  addToolCall: (toolCall: ToolCall) => void;
  updateToolCall: (id: string, update: Partial<ToolCall>) => void;
  finishStreaming: (usage?: ChatUsage) => void;
  setError: (error: string) => void;
  clearMessages: () => void;
  handleLLMEvent: (event: LLMEvent) => void;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  isStreaming: false,
  error: null,
  currentSessionId: undefined,
  usage: null,
  sessionsVersion: 0,

  setCurrentSessionId: (id) => set({ currentSessionId: id }),
  bumpSessions: () => set((s) => ({ sessionsVersion: s.sessionsVersion + 1 })),

  addUserMessage: (content) => {
    const msg: ChatMessage = {
      id: generateId(),
      role: "user",
      content,
      timestamp: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, msg], error: null }));
    return msg;
  },

  addAssistantMessage: () => {
    const msg: ChatMessage = {
      id: generateId(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
    };
    set((s) => ({
      messages: [...s.messages, msg],
      isStreaming: true,
      error: null,
    }));
    return msg;
  },

  appendToLastMessage: (text) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        msgs[msgs.length - 1] = { ...last, content: last.content + text };
      }
      return { messages: msgs };
    });
  },

  addToolCall: (toolCall) => {
    set((s) => {
      const msgs = [...s.messages];
      const toolMsg: ChatMessage = {
        id: generateId(),
        role: "tool",
        content: `Tool: ${toolCall.name}`,
        timestamp: Date.now(),
        toolCall,
      };
      return { messages: [...msgs, toolMsg] };
    });
  },

  updateToolCall: (id, update) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.toolCall?.id === id
          ? { ...m, toolCall: { ...m.toolCall, ...update } }
          : m,
      ),
    }));
  },

  finishStreaming: (usage) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        msgs[msgs.length - 1] = { ...last, isStreaming: false };
      }
      return { messages: msgs, isStreaming: false, usage: usage ?? s.usage };
    });
  },

  setError: (error) => {
    set({ error, isStreaming: false });
  },

  clearMessages: () => {
    set({ messages: [], error: null, isStreaming: false, usage: null });
  },

  handleLLMEvent: (event) => {
    switch (event.type) {
      case "text_delta": {
        const s = get();
        const last = s.messages[s.messages.length - 1];
        if (!last || last.role !== 'assistant' || !last.isStreaming) {
          set(state => ({
            messages: [...state.messages, {
              id: crypto.randomUUID?.() ?? Math.random().toString(36).slice(2),
              role: 'assistant',
              content: event.text,
              timestamp: Date.now(),
              isStreaming: true,
            }],
            isStreaming: true,
          }));
        } else {
          get().appendToLastMessage(event.text);
        }
        break;
      }
      case "tool_use":
        get().addToolCall({
          id: event.id,
          name: event.name,
          input: event.input,
          status: "pending",
        });
        break;
      case "tool_result": {
        const e = event as {
          type: "tool_result";
          toolUseID: string;
          toolName: string;
          content: string;
        };
        if (e.content === "Running...") {
          get().updateToolCall(e.toolUseID, { status: "running" });
        } else {
          get().updateToolCall(e.toolUseID, {
            status: "done",
            output: e.content,
          });
        }
        break;
      }
      case "message_stop":
        get().finishStreaming(event.usage);
        break;
      case "error":
        get().setError(event.error);
        break;
    }
  },
}));
