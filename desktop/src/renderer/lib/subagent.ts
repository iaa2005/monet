/**
 * Finding a sub-agent's LIVE state in a transcript.
 *
 * The expanded panel used to be handed a copy of the child's messages at the
 * moment the button was clicked. A sub-agent that was still working then kept
 * working — into an array nobody was watching, so the panel showed a frozen
 * prefix and the only cure was closing and reopening it.
 *
 * So the panel holds an id, and the state is looked up here on every render.
 * The search descends into sub-agents' own transcripts, because a sub-agent
 * can launch one, and that card has the same expand button.
 */

import type { ChatMessage, ToolCall, SubAgentState } from "../types/chat";

/** The Task tool call with this id, wherever it sits in the tree. */
export function findSubAgentCall(
  messages: ChatMessage[] | undefined,
  toolCallId: string,
): ToolCall | null {
  if (!messages) return null;
  for (const m of messages) {
    const tc = m.toolCall;
    if (!tc) continue;
    if (tc.id === toolCallId) return tc;
    const nested = findSubAgentCall(tc.subAgent?.messages, toolCallId);
    if (nested) return nested;
  }
  return null;
}

/**
 * What the panel draws. A Task call that has not reported yet has no
 * `subAgent` block at all, and the panel still has to say something — the
 * launch parameters are what is known about it.
 */
export function subAgentView(tc: ToolCall | null): SubAgentState | null {
  if (!tc) return null;
  if (tc.subAgent) return tc.subAgent;
  const input = tc.input ?? {};
  const agentType =
    typeof input["subagent_type"] === "string"
      ? (input["subagent_type"] as string)
      : "general-purpose";
  const description =
    typeof input["description"] === "string"
      ? (input["description"] as string)
      : undefined;
  return {
    agentType,
    description,
    status: tc.status === "done" || tc.status === "error" ? "done" : "running",
    messages: [],
  };
}
