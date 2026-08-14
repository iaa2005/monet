/**
 * The Plan dock panel — the plan document, whole.
 *
 * The chat card is the plan's summary; this is the .plan.md itself: title,
 * status, the detailed markdown, the todo list with live progress (agents
 * tick items as they work; the user can tick or untick a box too), and the
 * comment thread — the user's remarks go to the model on its next turn, the
 * agents' remarks say what they did and could not do, each under its own
 * name. Earlier plans of the session stay readable below the current one.
 */

import { useEffect, useMemo, useState, type JSX } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Circle,
  Download,
  ListTodo,
  Loader2,
  Minus,
  Send,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { comboLabel } from "@/lib/hotkeys";
import { useChatStore } from "@/stores/chatStore";
import { usePlanStore } from "@/stores/planStore";
import { MarkdownViewer } from "@/components/chat/MarkdownViewer";
import type { ElectronAPI, Plan, PlanTodoStatus } from "@/types/electron";

function bridge(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

const STATUS_LABEL: Record<Plan["status"], string> = {
  draft: "Draft — being revised",
  ready: "Ready — awaiting Build",
  building: "Building",
  done: "Done",
};

function TodoIcon({ status }: { status: string }): JSX.Element {
  if (status === "completed")
    return <Check className="size-3.5 shrink-0 text-green-text" />;
  if (status === "skipped")
    return <Minus className="size-3.5 shrink-0 text-muted-foreground/60" />;
  if (status === "in_progress")
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-link" />;
  return <Circle className="size-3 shrink-0 text-muted-foreground/50" />;
}

/** Clicking a box cycles the obvious way: pending → completed → pending. */
function nextStatus(status: PlanTodoStatus): PlanTodoStatus {
  return status === "completed" || status === "skipped"
    ? "pending"
    : "completed";
}

function timeOf(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function PlanDoc({ plan }: { plan: Plan }): JSX.Element {
  const [comment, setComment] = useState("");
  const done = plan.todos.filter(
    (t) => t.status === "completed" || t.status === "skipped",
  ).length;

  const sendComment = (): void => {
    const text = comment.trim();
    if (!text) return;
    void bridge()?.plan.comment(plan.id, text);
    setComment("");
  };

  const exportMd = async (): Promise<void> => {
    const md = await bridge()?.plan.markdown(plan.id);
    if (!md) return;
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${plan.title.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-+|-+$/g, "") || "plan"}.plan.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div>
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">{plan.title}</h1>
          {plan.summary ? (
            <p className="mt-0.5 text-sm text-muted-foreground">{plan.summary}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs",
              plan.status === "building"
                ? "bg-brand/15 text-brand"
                : plan.status === "done"
                  ? "bg-green-text/15 text-green-text"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {plan.status === "building" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : plan.status === "done" ? (
              <Check className="size-3" />
            ) : null}
            {STATUS_LABEL[plan.status]}
          </span>
          <button
            type="button"
            onClick={() => void exportMd()}
            title="Export as .plan.md"
            className="rounded-sm p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Download className="size-3.5" />
          </button>
        </div>
      </div>

      {/* ── The detailed plan ──────────────────────────────────────── */}
      {plan.body.trim() ? (
        <div className="mt-4 text-sm">
          <MarkdownViewer content={plan.body} />
        </div>
      ) : null}

      {/* ── Todos ──────────────────────────────────────────────────── */}
      {plan.todos.length > 0 ? (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {done}/{plan.todos.length} todos
            </span>
            {plan.agents.length > 0 ? (
              <span>
                Referenced by {plan.agents.length} agent
                {plan.agents.length === 1 ? "" : "s"}:{" "}
                {plan.agents.join(", ")}
              </span>
            ) : null}
          </div>
          <div className="flex flex-col border-t border-border">
            {plan.todos.map((t) => (
              <div
                key={t.id}
                className="flex items-start gap-2.5 border-b border-border py-2 text-sm"
              >
                <button
                  type="button"
                  onClick={() =>
                    void bridge()?.plan.setTodo(
                      plan.id,
                      t.id,
                      nextStatus(t.status),
                    )
                  }
                  title="Toggle"
                  className="mt-0.5 flex size-4 items-center justify-center"
                >
                  <TodoIcon status={t.status} />
                </button>
                <div className="min-w-0 flex-1">
                  <span
                    className={cn(
                      (t.status === "completed" || t.status === "skipped") &&
                        "text-muted-foreground line-through",
                    )}
                  >
                    {t.text}
                  </span>
                  {t.note ? (
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t.note}
                      {t.by ? ` — ${t.by}` : ""}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── Comments ───────────────────────────────────────────────── */}
      <div className="mt-5">
        <div className="mb-2 text-xs text-muted-foreground">
          {plan.comments.length > 0
            ? `${plan.comments.length} comment${plan.comments.length === 1 ? "" : "s"}`
            : "Comments"}
        </div>
        <div className="flex flex-col gap-2.5">
          {plan.comments.map((c) => (
            <div key={c.id} className="flex items-start gap-2 text-sm">
              <span
                className={cn(
                  "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium",
                  c.kind === "user"
                    ? "bg-brand/15 text-brand"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {c.kind === "user" ? (
                  <User className="size-3" />
                ) : (
                  (c.author[0] ?? "a").toUpperCase()
                )}
              </span>
              <div className="min-w-0 flex-1">
                <span className="mr-2 text-xs font-medium">
                  {c.kind === "user" ? "You" : c.author}
                </span>
                <span className="text-xs text-muted-foreground">
                  {timeOf(c.at)}
                </span>
                {c.kind === "user" && !c.seenByAgent ? (
                  <span className="ml-2 text-[10px] text-muted-foreground">
                    · goes to the agent next turn
                  </span>
                ) : null}
                <div className="mt-0.5 whitespace-pre-wrap">{c.text}</div>
              </div>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendComment();
              }}
              placeholder="Comment on the plan…"
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={sendComment}
              disabled={!comment.trim()}
              title="Add comment"
              className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted disabled:opacity-40"
            >
              <Send className="size-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The verdict, available where the user actually reads the plan. Same pair
 * as the chat card — Cancel / Build with the auto-accept follow-up — so
 * approving from the panel and from the card are one act, not two features.
 */
function PendingActions({ sessionId }: { sessionId: string }): JSX.Element | null {
  const request = usePlanStore((s) => s.request);
  const respond = usePlanStore((s) => s.respond);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const pending =
    request !== null &&
    (request.sessionId === undefined || request.sessionId === sessionId);
  // A resolved request must not leave the confirm step armed for the next one.
  useEffect(() => {
    if (!pending) setConfirmAuto(false);
  }, [pending]);
  if (!pending) return null;

  return (
    <div className="sticky top-0 z-10 -mx-1 rounded-lg border border-border bg-card px-3 py-2 shadow-sm">
      {!confirmAuto ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => respond("cancel")}
            className="rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            Cancel
          </button>
          <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
            To change the plan, just reply in chat
          </span>
          <button
            type="button"
            onClick={() => setConfirmAuto(true)}
            className="flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            Build
            <span className="text-xs opacity-70">{comboLabel("mod+enter")}</span>
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setConfirmAuto(false)}
            className="mr-auto flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            <ArrowLeft className="size-3.5" />
            Back
          </button>
          <span className="text-xs text-muted-foreground">
            Auto-accept edits while building?
          </span>
          <button
            type="button"
            onClick={() => respond("approve")}
            className="rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            Ask each time
          </button>
          <button
            type="button"
            onClick={() => respond("approve-auto")}
            className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            Auto-accept
          </button>
        </div>
      )}
    </div>
  );
}

/** An earlier plan, collapsed to a row until opened. */
function PastPlan({ plan }: { plan: Plan }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate text-left">{plan.title}</span>
        <span className="text-xs">{STATUS_LABEL[plan.status]}</span>
      </button>
      {open ? (
        <div className="mt-3">
          <PlanDoc plan={plan} />
        </div>
      ) : null}
    </div>
  );
}

export function PlanPanel(): JSX.Element {
  const sessionId = useChatStore((s) => s.currentSessionId ?? "default");
  const current = usePlanStore((s) => s.plans[sessionId]);
  const load = usePlanStore((s) => s.load);
  const [history, setHistory] = useState<Plan[]>([]);

  useEffect(() => load(sessionId), [load, sessionId]);
  // History refreshes with the same broadcast the store listens to; `current`
  // changing is exactly that signal.
  useEffect(() => {
    let alive = true;
    void bridge()
      ?.plan.list(sessionId)
      .then((all) => {
        if (alive) setHistory(all);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, current]);

  const past = useMemo(
    () => history.filter((p) => p.id !== current?.id).reverse(),
    [history, current],
  );

  if (!current && past.length === 0)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
        <ListTodo className="size-6 opacity-50" />
        <div>No plan yet.</div>
        <div className="max-w-64 text-xs">
          Switch the composer to Plan mode and ask for something — the agent
          researches first and hands you a plan to build.
        </div>
      </div>
    );

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-4">
      <PendingActions sessionId={sessionId} />
      {current ? <PlanDoc plan={current} /> : null}
      {past.length > 0 ? (
        <div className="flex flex-col gap-3">
          <div className="text-xs text-muted-foreground">Earlier plans</div>
          {past.map((p) => (
            <PastPlan key={p.id} plan={p} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
