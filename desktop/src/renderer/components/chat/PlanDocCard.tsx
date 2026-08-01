/**
 * The plan card — what an ExitPlanMode call looks like in the transcript.
 *
 * Cursor-style "Prepared plan": a document card with the title, a one-line
 * summary, a "Read detailed plan" link that opens the Plan dock panel, and
 * the todo list the user will watch fill in. While the approval round-trip
 * is open THIS card carries the verdict buttons (Build / build+auto-accept /
 * keep planning with a note) — the old full-screen modal is gone.
 *
 * The card prefers the live document (planStore) so ticks appear as agents
 * work; the tool-call input is the fallback for old transcripts whose plan
 * rows are gone.
 */

import { useEffect, useState, type JSX } from "react";
import {
  Check,
  Circle,
  ListTodo,
  Loader2,
  Minus,
  PanelRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { comboLabel, isMac } from "@/lib/hotkeys";
import { usePlanStore } from "@/stores/planStore";
import { useChatStore } from "@/stores/chatStore";
import { useDockStore } from "@/dock/dock-store";
import type { Plan } from "@/types/electron";
import type { ToolCall } from "@/types/chat";

interface PlanInput {
  title?: string;
  summary?: string;
  plan?: string;
  todos?: string[];
}

function slugOf(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "plan"}.plan.md`;
}

function TodoIcon({ status }: { status: string }): JSX.Element {
  if (status === "completed")
    return <Check className="size-3.5 shrink-0 text-green-text" />;
  if (status === "skipped")
    return <Minus className="size-3.5 shrink-0 text-muted-foreground/60" />;
  if (status === "in_progress")
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-link" />;
  return <Circle className="size-3 shrink-0 text-muted-foreground/50" />;
}

const STATUS_LABEL: Record<Plan["status"], string | null> = {
  draft: "Revising",
  ready: null,
  building: "Building",
  done: "Done",
};

export function PlanDocCard({
  toolCall,
}: {
  toolCall: ToolCall;
}): JSX.Element {
  const sessionId = useChatStore((s) => s.currentSessionId ?? "default");
  const input = (toolCall.input ?? {}) as PlanInput;
  const livePlan = usePlanStore((s) => s.plans[sessionId]);
  const request = usePlanStore((s) => s.request);
  const respond = usePlanStore((s) => s.respond);
  const load = usePlanStore((s) => s.load);
  const [feedback, setFeedback] = useState("");
  // Build is two steps: the button, then "auto-accept edits while building?"
  // — the mode question comes AFTER the decision to build, not beside it.
  const [confirmAuto, setConfirmAuto] = useState(false);

  useEffect(() => load(sessionId), [load, sessionId]);

  // The live document, but only when it is THIS card's plan: a session can
  // hold several plans over its life, and an old card must not adopt a new
  // plan. Title match is the tie we have for historical cards.
  const plan =
    livePlan && (livePlan.title === input.title || !input.title)
      ? livePlan
      : null;

  // The verdict buttons belong to the card whose call is still open in this
  // session. Deliberately NOT keyed on planId: the document is a nicety the
  // card can render without, while a mismatch there would leave the user
  // with no way to answer at all.
  const pending =
    request !== null &&
    (request.sessionId === undefined || request.sessionId === sessionId) &&
    toolCall.status !== "done" &&
    toolCall.status !== "error";

  // Tell the store this request has a UI (see claimedRequestId).
  const claim = usePlanStore((s) => s.claimRequest);
  useEffect(() => {
    if (pending && request) claim(request.id);
  }, [pending, request, claim]);

  const title = plan?.title ?? input.title ?? "Plan";
  const summary = plan?.summary ?? input.summary;
  const todos =
    plan?.todos ??
    (input.todos ?? []).map((text, i) => ({
      id: String(i),
      text,
      status: "pending",
      note: undefined as string | undefined,
      by: undefined as string | undefined,
    }));
  const statusChip = plan ? STATUS_LABEL[plan.status] : null;
  const done = todos.filter(
    (t) => t.status === "completed" || t.status === "skipped",
  ).length;

  const openPanel = (): void => useDockStore.getState().openPanel("plan");

  // Cmd/Ctrl+Enter while the verdict is pending. The same combo sends a
  // composer message, so focus decides: in the card's note field it submits
  // THAT intent (empty note → Build, note → keep planning with it); in any
  // other input it stays the composer's key; anywhere else it Builds.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Enter" || !(isMac ? e.metaKey : e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      const inNote = !!t?.closest("[data-plan-note]");
      if (!inNote && t?.closest("textarea, input, [contenteditable=true]"))
        return;
      e.preventDefault();
      const note = feedback.trim();
      if (inNote && note) respond("keep-planning", note);
      else if (!confirmAuto) setConfirmAuto(true);
      // On the confirm step the same combo takes the primary answer: auto.
      else respond("approve-auto");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, respond, feedback, confirmAuto]);

  return (
    <div className="my-2">
      <div className="mb-1.5 text-xs text-muted-foreground">Prepared plan</div>
      <div className="rounded-md border border-border bg-card">
        {/* Header: the document's "file name" + open-as-panel */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <ListTodo className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {slugOf(title)}
          </span>
          {statusChip ? (
            <span
              className={cn(
                "flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px]",
                plan?.status === "building"
                  ? "bg-brand/15 text-brand"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {plan?.status === "building" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : null}
              {statusChip}
            </span>
          ) : null}
          <button
            type="button"
            onClick={openPanel}
            title="Open the plan panel"
            className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <PanelRight className="size-3.5" />
          </button>
        </div>

        <div className="px-4 py-3">
          <div className="text-base font-semibold">{title}</div>
          {summary ? (
            <div className="mt-0.5 text-sm text-muted-foreground">{summary}</div>
          ) : null}
          <button
            type="button"
            onClick={openPanel}
            className="mt-1.5 text-sm text-link hover:underline"
          >
            Read detailed plan
          </button>

          {todos.length > 0 ? (
            <div className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2">
              <div className="mb-1.5 text-xs text-muted-foreground">
                {done > 0 ? `${done}/${todos.length}` : todos.length} todos
              </div>
              <div className="flex flex-col gap-1.5">
                {todos.map((t) => (
                  <div key={t.id} className="flex items-start gap-2 text-sm">
                    <span className="mt-0.5 flex size-4 items-center justify-center">
                      <TodoIcon status={t.status} />
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1",
                        (t.status === "completed" || t.status === "skipped") &&
                          "text-muted-foreground line-through",
                      )}
                    >
                      {t.text}
                      {t.note ? (
                        <span className="ml-1 text-xs text-muted-foreground no-underline">
                          — {t.note}
                        </span>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {pending && !confirmAuto ? (
          <div className="border-t border-border px-4 py-3">
            <textarea
              data-plan-note
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Optional: what to change (sent if you keep planning)"
              rows={2}
              className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
            />
            <div className="mt-2.5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => respond("keep-planning", feedback)}
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Keep planning
              </button>
              <button
                type="button"
                onClick={() => setConfirmAuto(true)}
                className="flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
              >
                Build
                <span className="text-xs opacity-70">{comboLabel("mod+enter")}</span>
              </button>
            </div>
          </div>
        ) : null}

        {pending && confirmAuto ? (
          <div className="border-t border-border px-4 py-3">
            <div className="text-sm">
              Auto-accept edits while building?
              <span className="ml-1.5 text-xs text-muted-foreground">
                Workspace edits stop asking; risky commands still do.
              </span>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmAuto(false)}
                className="mr-auto rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={() => respond("approve")}
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Ask each time
              </button>
              <button
                type="button"
                onClick={() => respond("approve-auto")}
                className="flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
              >
                Auto-accept
                <span className="text-xs opacity-70">{comboLabel("mod+enter")}</span>
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
