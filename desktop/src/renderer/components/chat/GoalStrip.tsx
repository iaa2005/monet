/**
 * The goal strip — what is running, how far in, and how to stop it.
 *
 * Autonomy needs a visible handle. A run that keeps taking turns on its own
 * must say so on screen at all times, show what it is spending, and put pause
 * and cancel one click away — otherwise "self-sufficient" is indistinguishable
 * from "stuck in a loop".
 */

import { useEffect, useState } from "react";
import { CircleDot, Pause, Play, Target, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import type { ElectronAPI, GoalRecord } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

const STATUS_TEXT: Record<GoalRecord["status"], string> = {
  active: "Working",
  paused: "Paused",
  blocked: "Blocked",
};

const STATUS_DOT: Record<GoalRecord["status"], string> = {
  active: "text-green-text",
  paused: "text-muted-foreground",
  blocked: "text-red-text",
};

export function GoalStrip(): JSX.Element | null {
  const sessionId = useChatStore((s) => s.currentSessionId);
  const messages = useChatStore((s) => s.messages);
  const [goal, setGoal] = useState<GoalRecord | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // Re-read after every turn: the driver advances the record in main, and the
  // strip is how the user sees a run they are not otherwise watching.
  useEffect(() => {
    let alive = true;
    void api()
      ?.goal.get(sessionId ?? "default")
      .then((g) => {
        if (alive) setGoal(g);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, messages.length]);

  useEffect(() => {
    setConfirmCancel(false);
    setExpanded(false);
  }, [sessionId]);

  if (!goal) return null;

  const pct =
    goal.budget.maxTurns > 0
      ? Math.min(100, (goal.stats.turns / goal.budget.maxTurns) * 100)
      : 0;

  const act = async (
    fn: () => Promise<GoalRecord | null | { ok: boolean }>,
  ): Promise<void> => {
    const r = await fn();
    if (r && "id" in r) setGoal(r as GoalRecord);
    else setGoal(null);
  };

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 px-3 py-2">
        <Target className="size-4 shrink-0 text-muted-foreground" />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="min-w-0 flex-1 text-left"
          title={goal.objective}
        >
          <div className="flex items-center gap-1.5">
            <CircleDot className={cn("size-3 shrink-0", STATUS_DOT[goal.status])} />
            <span className="text-xs font-medium">{STATUS_TEXT[goal.status]}</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              turn {goal.stats.turns}/{goal.budget.maxTurns}
            </span>
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {goal.objective}
          </div>
        </button>

        {goal.status === "active" ? (
          <button
            type="button"
            onClick={() => void act(() => api()!.goal.pause(sessionId ?? "default"))}
            title="Pause — the current turn finishes, then it stops"
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
          >
            <Pause className="size-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void act(() => api()!.goal.resume(sessionId ?? "default"))}
            title="Resume — send a message to start the next turn"
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
          >
            <Play className="size-4" />
          </button>
        )}

        {/* Cancel deletes the goal and cannot be undone, so it asks once. */}
        {confirmCancel ? (
          <button
            type="button"
            onClick={() => void act(() => api()!.goal.cancel(sessionId ?? "default"))}
            className="shrink-0 rounded-md bg-destructive px-2 py-1 text-[11px] font-medium text-white"
          >
            Cancel goal?
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmCancel(true)}
            title="Cancel the goal"
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      <div className="h-0.5 bg-muted">
        <div
          className={cn(
            "h-full transition-all",
            goal.status === "active" ? "bg-green-text" : "bg-muted-foreground/50",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>

      {expanded && (
        <div className="space-y-1 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          {goal.completionCriterion && (
            <div>
              <span className="font-medium text-foreground">Done when: </span>
              {goal.completionCriterion}
            </div>
          )}
          {goal.stopDetail && (
            <div>
              <span className="font-medium text-foreground">Stopped: </span>
              {goal.stopDetail}
            </div>
          )}
          <div>
            {goal.stats.tokens.toLocaleString()} tokens
            {goal.budget.maxTokens
              ? ` of ${goal.budget.maxTokens.toLocaleString()}`
              : ""}
          </div>
          <div>
            {goal.connectorGrants.length > 0 ? (
              <>
                <span className="font-medium text-foreground">
                  May use without asking:{" "}
                </span>
                {goal.connectorGrants.join(", ")}
              </>
            ) : (
              "No standing connector permissions — anything leaving the machine asks first."
            )}
          </div>
        </div>
      )}
    </div>
  );
}
