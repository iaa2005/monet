/**
 * The answer of last resort for a pending plan.
 *
 * The plan card carries the Build buttons, and normally that is the only
 * place they belong. But the card can fail to appear — it did: the plan call
 * was folded into a tool group, the group rendered its members as plain rows,
 * and the approval sat there with nothing on screen to answer it until the
 * ten-minute timeout expired. A turn must never be unanswerable, so if no
 * card has claimed the request (planStore.claimedRequestId), this bar takes
 * it — above the composer, where the user is already looking.
 *
 * It also covers the honest cases: the plan scrolled out of the transcript's
 * mounted window, or the user switched chats and came back.
 */

import { type JSX } from "react";
import { ListTodo } from "lucide-react";
import { usePlanStore } from "@/stores/planStore";
import { useChatStore } from "@/stores/chatStore";
import { useDockStore } from "@/dock/dock-store";
import { comboLabel } from "@/lib/hotkeys";

export function PlanFallbackBar(): JSX.Element | null {
  const request = usePlanStore((s) => s.request);
  const claimed = usePlanStore((s) => s.claimedRequestId);
  const respond = usePlanStore((s) => s.respond);
  const sessionId = useChatStore((s) => s.currentSessionId ?? "default");

  if (!request) return null;
  if (request.sessionId !== undefined && request.sessionId !== sessionId)
    return null;
  if (claimed === request.id) return null;

  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm">
      <ListTodo className="size-4 shrink-0 text-brand" />
      <span className="min-w-0 flex-1">
        A plan is waiting for you.
        <button
          type="button"
          onClick={() => useDockStore.getState().openPanel("plan")}
          className="ml-1.5 text-link hover:underline"
        >
          Read it
        </button>
      </span>
      <button
        type="button"
        onClick={() => respond("keep-planning")}
        className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
      >
        Keep planning
      </button>
      <button
        type="button"
        onClick={() => respond("approve")}
        title={`Build — ${comboLabel("mod+enter")}`}
        className="shrink-0 rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
      >
        Build
      </button>
    </div>
  );
}
