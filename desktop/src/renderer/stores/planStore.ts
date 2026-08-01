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
  load: (sessionId: string) => void;
  respond: (decision: PlanDecision, feedback?: string) => void;
}

export const usePlanStore = create<PlanState>((set, get) => ({
  plans: {},
  request: null,

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
    set({ request: null });
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
  if (api?.plan?.onRequest) {
    api.plan.onRequest((req) => {
      usePlanStore.setState({ request: req });
      // The document behind the request is about to be rendered — have it.
      const sid = (req as PlanRequest).sessionId;
      if (sid) usePlanStore.getState().load(sid);
      // A prepared plan opens its panel, like Cursor opening the .plan.md
      // tab. openPanel queues the reveal if the dock is not up yet.
      useDockStore.getState().openPanel("plan");
    });
  }
}
