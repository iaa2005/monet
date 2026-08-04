/**
 * The plan document in the renderer — one source for the chat card and the
 * dock panel.
 *
 * Holds each session's current plan (fetched once, refreshed on the
 * `plan:changed` broadcast) and the pending approval request, which used to
 * be private state inside a modal. The card renders the Build buttons off
 * `request`; both surfaces render the document off `plans`.
 */

import { create } from "zustand";
import { useDockStore } from "../dock/dock-store";
import { useChatStore } from "./chatStore";
import type { ElectronAPI, Plan } from "../types/electron";

export interface PlanRequest {
  id: string;
  plan: string;
  planId?: string;
  sessionId?: string;
}

export type PlanDecision = "approve" | "approve-auto" | "keep-planning";

function bridge(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

interface PlanState {
  /** sessionId → its current plan (null = fetched, none exists). */
  plans: Record<string, Plan | null>;
  /** A plan awaiting the user's Build / keep-planning verdict. */
  request: PlanRequest | null;
  /** The request id some card is currently showing buttons for. A pending
   * request nobody claimed means the user has NOTHING to answer with — the
   * turn then hangs until the ten-minute timeout, which is exactly what
   * happened when the plan call got folded into a tool group. ChatView
   * watches this and puts a fallback bar above the composer. */
  claimedRequestId: string | null;
  claimRequest: (id: string) => void;
  load: (sessionId: string) => void;
  respond: (decision: PlanDecision, feedback?: string) => void;
}

export const usePlanStore = create<PlanState>((set, get) => ({
  plans: {},
  request: null,
  claimedRequestId: null,

  claimRequest: (id) =>
    set((s) => (s.claimedRequestId === id ? s : { claimedRequestId: id })),

  load: (sessionId: string) => {
    const api = bridge();
    if (!api?.plan?.current) return;
    void api.plan.current(sessionId).then((plan) => {
      set((s) => ({ plans: { ...s.plans, [sessionId]: plan } }));
    });
  },

  respond: (decision, feedback) => {
    const req = get().request;
    if (!req) return;
    // The mode selector reads this on every send, so approval has to land
    // here too or the next turn would go back to plan mode.
    if (decision === "approve" || decision === "approve-auto") {
      localStorage.setItem(
        "permission-mode",
        decision === "approve-auto" ? "acceptEdits" : "default",
      );
      window.dispatchEvent(new CustomEvent("permission-mode-changed"));
    }
    bridge()?.plan.respond(
      req.id,
      decision,
      decision === "keep-planning" ? feedback?.trim() || undefined : undefined,
    );
    set({ request: null, claimedRequestId: null });
  },
}));

// Module-level wiring: one subscription per window, alive for its lifetime.
{
  const api = bridge();
  if (api?.plan?.onChanged) {
    api.plan.onChanged((sessionId) => {
      // Refresh only sessions someone has looked at; the rest fetch on demand.
      if (sessionId in usePlanStore.getState().plans)
        usePlanStore.getState().load(sessionId);
    });
  }
  if (api?.plan?.onModeChanged) {
    api.plan.onModeChanged(({ sessionId, mode }) => {
      // Only the visible chat's selector follows; a background session's
      // mode change must not repaint the composer someone else is using.
      const cur = useChatStore.getState().currentSessionId ?? "default";
      if (sessionId !== cur) return;
      localStorage.setItem("permission-mode", mode);
      window.dispatchEvent(new CustomEvent("permission-mode-changed"));
    });
  }
  if (api?.plan?.onRequest) {
    api.plan.onRequest((req) => {
      usePlanStore.setState({ request: req, claimedRequestId: null });
      // The document behind the request is about to be rendered — have it.
      const sid = (req as PlanRequest).sessionId;
      if (sid) usePlanStore.getState().load(sid);
      // A prepared plan opens its panel, like Cursor opening the .plan.md
      // tab — but only in ITS OWN chat. With the user reading another chat
      // the empty plan panel used to pop open there; the voice pill and the
      // sidebar already say a plan is waiting.
      const curNow = useChatStore.getState().currentSessionId ?? "default";
      if (!sid || sid === curNow) useDockStore.getState().openPanel("plan");
    });
  }
}
