/**
 * Plan approval — the model hands over a plan and the user decides.
 *
 * Approving also switches the permission mode, both here (so the next turn is
 * sent under it) and in main (so the REST OF THIS TURN runs under it — the
 * model was just told to start working and its next tool call must not hit a
 * plan-mode block).
 */

import { useEffect, useState, type JSX } from "react";
import type { ElectronAPI } from "../../types/electron";
import { MarkdownViewer } from "./MarkdownViewer";

type PlanDecision = "approve" | "approve-auto" | "keep-planning";

interface PlanRequest {
  id: string;
  plan: string;
}

function bridge(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

export function PlanApprovalHost(): JSX.Element | null {
  const [request, setRequest] = useState<PlanRequest | null>(null);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    const api = bridge();
    if (!api?.plan) return;
    return api.plan.onRequest((req) => {
      setFeedback("");
      setRequest(req);
    });
  }, []);

  if (!request) return null;

  const respond = (decision: PlanDecision): void => {
    // The mode selector reads this on every send, so approval has to land here
    // too or the next turn would go back to plan mode.
    if (decision === "approve" || decision === "approve-auto") {
      localStorage.setItem(
        "permission-mode",
        decision === "approve-auto" ? "acceptEdits" : "default",
      );
      window.dispatchEvent(new CustomEvent("permission-mode-changed"));
    }
    bridge()?.plan.respond(
      request.id,
      decision,
      decision === "keep-planning" ? feedback.trim() || undefined : undefined,
    );
    setRequest(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-background shadow-xl">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">Ready to start?</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Review the plan before any changes are made.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm">
          <MarkdownViewer content={request.plan} />
        </div>

        <div className="border-t border-border px-5 py-3">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Optional: what to change (sent if you keep planning)"
            rows={2}
            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => respond("keep-planning")}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Keep planning
            </button>
            <button
              type="button"
              onClick={() => respond("approve-auto")}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Approve + auto-accept edits
            </button>
            <button
              type="button"
              onClick={() => respond("approve")}
              className="rounded-lg bg-foreground px-3 py-1.5 text-sm text-background hover:opacity-90"
            >
              Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
