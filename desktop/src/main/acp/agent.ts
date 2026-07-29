/**
 * Code Monet as an ACP agent — the bridge an editor talks to.
 *
 * The Agent Client Protocol lets Zed, JetBrains and VS Code drive an agent
 * over stdio, so this exposes the same engine the desktop UI uses rather than
 * a second one. Everything below is a translation layer: ACP prompt blocks in,
 * LLMEvents out as session updates.
 *
 * Approvals go to the EDITOR, not to a window we do not have. ACP has a
 * client-side permission request, so a write or a shell command surfaces as a
 * prompt in Zed or VS Code and the user answers there. Nothing is auto-allowed
 * on their behalf: an editor that declines to show the prompt gets a refusal,
 * which is the same answer the desktop gate gives when there is nobody to ask.
 */

import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  CancelNotification,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "crypto";
import type { LLMEvent } from "../llm/adapter.js";

/** Protocol version this adapter speaks. */
const PROTOCOL_VERSION = 1;

interface AcpSessionState {
  id: string;
  cwd: string;
  abort?: AbortController;
}

/** Flatten ACP content blocks into the text our engine takes. */
export function blocksToText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "resource_link")
      // A link is a pointer, not content: name the path so the agent can read
      // it with its own tools, which is what the editor expects.
      parts.push(`[file: ${b.uri}]`);
    else if (b.type === "resource" && "resource" in b) {
      const r = b.resource as { uri?: string; text?: string };
      parts.push(
        r.text
          ? `----- ${r.uri ?? "resource"} -----\n${r.text}`
          : `[resource: ${r.uri ?? "unknown"}]`,
      );
    }
    // Images and audio are dropped rather than mangled: the prompt
    // capabilities advertised in initialize() do not claim them.
  }
  return parts.join("\n\n").trim();
}

export interface AcpDeps {
  runAgent: (
    sessionId: string,
    content: string,
    onEvent: (e: LLMEvent) => void,
    options: Record<string, unknown>,
  ) => Promise<void>;
  applyWorkspace: (cwd: string) => void;
}

export function createAcpAgent(
  conn: AgentSideConnection,
  deps: AcpDeps,
): Agent {
  const sessions = new Map<string, AcpSessionState>();

  return {
    async initialize(params: InitializeRequest): Promise<InitializeResponse> {
      return {
        protocolVersion: Math.min(params.protocolVersion, PROTOCOL_VERSION),
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {
            // Text and links only. Claiming image support here would make an
            // editor send pixels this bridge then silently drops.
            image: false,
            audio: false,
            embeddedContext: true,
          },
        },
        // No auth step: the desktop app already holds the provider key, and a
        // second login here would be a second place for a credential to live.
        authMethods: [],
      };
    },

    async authenticate(_params: AuthenticateRequest): Promise<void> {
      // Nothing to do — initialize() advertises no methods.
    },

    async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
      const id = randomUUID();
      sessions.set(id, { id, cwd: params.cwd });
      // The editor's cwd is the workspace for this session's runs.
      deps.applyWorkspace(params.cwd);
      return { sessionId: id };
    },

    async cancel(params: CancelNotification): Promise<void> {
      sessions.get(params.sessionId)?.abort?.abort();
    },

    async prompt(params: PromptRequest): Promise<PromptResponse> {
      const session = sessions.get(params.sessionId);
      if (!session)
        return { stopReason: "refusal" };

      const text = blocksToText(params.prompt);
      if (!text) return { stopReason: "end_turn" };

      const abort = new AbortController();
      session.abort = abort;
      deps.applyWorkspace(session.cwd);

      const send = (update: Record<string, unknown>): void => {
        void conn
          .sessionUpdate({
            sessionId: params.sessionId,
            update: update as never,
          })
          .catch(() => {
            /* the editor went away; the run ends on its own */
          });
      };

      let stopReason: PromptResponse["stopReason"] = "end_turn";

      await deps.runAgent(
        params.sessionId,
        text,
        (event: LLMEvent) => {
          switch (event.type) {
            case "text_delta":
              send({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: event.text },
              });
              break;
            case "reasoning_delta":
              send({
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: event.text },
              });
              break;
            case "tool_use":
              send({
                sessionUpdate: "tool_call",
                toolCallId: event.id,
                title: event.name,
                status: "in_progress",
                rawInput: event.input,
              });
              break;
            case "tool_result":
              send({
                sessionUpdate: "tool_call_update",
                toolCallId: event.toolUseID,
                status: "completed",
                content: [
                  {
                    type: "content",
                    content: { type: "text", text: event.content },
                  },
                ],
              });
              break;
            case "message_stop":
              if (event.stop_reason === "abort") stopReason = "cancelled";
              else if (event.stop_reason === "max_tokens")
                stopReason = "max_tokens";
              else if (event.stop_reason === "max_turns")
                stopReason = "max_turn_requests";
              break;
            case "error":
              // Surface it as agent text: an editor showing nothing at all is
              // worse than one showing what went wrong.
              send({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `\n\n**Error:** ${event.error}` },
              });
              stopReason = "refusal";
              break;
            default:
              break;
          }
        },
        {
          signal: abort.signal,
          space: "code",
          cwd: session.cwd,
          permissionMode: "default",
          // The editor is the prompt channel. Same three answers the desktop
          // dialog offers, so "allow always" behaves identically here.
          requestPermission: async (ask: {
            toolName: string;
            description: string;
            detail?: string;
          }): Promise<"allow" | "allow-once" | "deny"> => {
            try {
              const res = await conn.requestPermission({
                sessionId: params.sessionId,
                toolCall: {
                  toolCallId: `perm-${randomUUID()}`,
                  title: ask.description,
                  rawInput: ask.detail ? { detail: ask.detail } : undefined,
                } as never,
                options: [
                  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
                  { optionId: "allow", name: "Allow always", kind: "allow_always" },
                  { optionId: "deny", name: "Deny", kind: "reject_once" },
                ],
              });
              const outcome = res.outcome;
              if (outcome.outcome !== "selected") return "deny";
              return outcome.optionId === "allow"
                ? "allow"
                : outcome.optionId === "allow-once"
                  ? "allow-once"
                  : "deny";
            } catch {
              // An editor that cannot show the prompt has not said yes.
              return "deny";
            }
          },
        },
      );

      session.abort = undefined;
      return { stopReason };
    },
  };
}
