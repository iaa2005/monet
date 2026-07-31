/**
 * Background tasks — what the agent is actually doing, one row per tool run.
 *
 * This used to list streaming SESSIONS, so a chat forty commands deep showed
 * as a single "Running in background…". The interesting unit is the execution:
 * which command, under what name the model gave it, what came back.
 *
 * Rows come from taskStore, fed off the same ordered event stream as the chat.
 * Running chats keep their own compact strip at the top, because jumping to one
 * and stopping it are still the two things you reach for mid-run.
 *
 * It lives in the right panel, beside Files and Artifacts — the three answer the
 * same question from different angles, so they share one surface. It was a
 * popover hanging off the toolbar, which put it somewhere else entirely and made
 * it the only one of the three you could not resize or keep open while working.
 */

import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Square,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import {
  taskDuration,
  toolLabel,
  useTaskStore,
  type TaskEntry,
} from "@/stores/taskStore";
import type { ChatMessage } from "@/types/chat";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

function chatLabel(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content?.trim());
  const t = firstUser?.content?.trim();
  if (!t) return "Untitled chat";
  return t.length > 44 ? `${t.slice(0, 44)}…` : t;
}

const STATUS_TEXT: Record<TaskEntry["status"], string> = {
  running: "Running",
  done: "Completed",
  error: "Failed",
};

/** Long output is the norm (a build log, a file dump). Show the tail — the
 * verdict lives at the end — and say how much was cut. */
const OUTPUT_LIMIT = 1400;

function TaskRow({ task }: { task: TaskEntry }): JSX.Element {
  const [open, setOpen] = useState(false);
  const hasBody = !!(task.detail || task.output);
  const out = task.output ?? "";
  const clipped = out.length > OUTPUT_LIMIT;
  const shown = clipped ? out.slice(-OUTPUT_LIMIT) : out;

  return (
    // overflow-hidden so the row's hover fill is cut by the card's own radius —
    // without it the highlight is a square behind rounded corners — and so the
    // opened body can run edge to edge.
    <div className="overflow-hidden rounded-lg border border-border bg-card/40">
      <button
        type="button"
        disabled={!hasBody}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-start gap-2 px-3 py-2 text-left",
          hasBody && "hover:bg-black/[0.04] dark:hover:bg-white/[0.05]",
        )}
      >
        <span className="mt-0.5 shrink-0">
          {task.status === "running" ? (
            <Loader2 className="size-3.5 animate-spin text-green-text" />
          ) : task.status === "error" ? (
            <X className="size-3.5 text-destructive" />
          ) : (
            <Check className="size-3.5 text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-foreground">
            {task.title}
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>{toolLabel(task.tool)}</span>
            <span>{STATUS_TEXT[task.status]}</span>
            <span className="tabular-nums">{taskDuration(task)}</span>
          </span>
        </span>
        {/* A running row is the only one worth interrupting, and the honest
            label is what it does: this stops the whole run the tool belongs to,
            because a tool call is not cancellable on its own. A span, not a
            button — this sits inside the row's own button. */}
        {task.status === "running" && (
          <span
            role="button"
            tabIndex={0}
            title="Stop the run this task belongs to"
            onClick={(e) => {
              e.stopPropagation();
              void api()?.chat.abort(task.sessionId);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              e.stopPropagation();
              void api()?.chat.abort(task.sessionId);
            }}
            className="mt-0.5 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <Square className="size-3 fill-current" />
            Stop
          </span>
        )}
        {hasBody && (
          <span className="mt-0.5 shrink-0 text-muted-foreground">
            {open ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </span>
        )}
      </button>

      {open && hasBody && (
        // No padding of its own, and the blocks lose their rounding: a command
        // line inset by the card AND by its own box had barely half the width
        // left for the text, which is the thing anyone opened this to read.
        <div className="border-t border-border">
          {task.detail && (
            <pre className="overflow-x-auto bg-black/[0.05] px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground dark:bg-white/[0.06]">
              <span className="select-none text-muted-foreground">$ </span>
              {task.detail}
            </pre>
          )}
          {out && (
            <pre className="max-h-64 overflow-auto border-t border-border bg-black/[0.05] px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground dark:bg-white/[0.06]">
              {clipped && (
                <span className="select-none italic">
                  … {out.length - OUTPUT_LIMIT} earlier characters hidden{"\n"}
                </span>
              )}
              {shown}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The toolbar button's live count — work of either kind, in any chat.
 *
 * Its own hook because the button now sits in App while the rows live here, and
 * a count derived twice would eventually disagree with itself.
 */
export function useTaskBadge(): number {
  const sessions = useChatStore((s) => s.sessions);
  const tasks = useTaskStore((s) => s.tasks);
  const live = tasks.filter((t) => t.status === "running").length;
  // A chat thinking between tools has no running task, and a task can outlive
  // the visible chat — so neither count alone covers "something is happening".
  return live || Object.values(sessions).filter((st) => st.isStreaming).length;
}

interface BackgroundTasksProps {
  onOpen: (sessionId: string) => void;
  currentSessionId?: string;
}

export function BackgroundTasksPanel({
  onOpen,
  currentSessionId,
}: BackgroundTasksProps): JSX.Element {
  const sessions = useChatStore((s) => s.sessions);
  const tasks = useTaskStore((s) => s.tasks);
  const clearTasks = useTaskStore((s) => s.clear);
  const hydrate = useTaskStore((s) => s.hydrate);

  // History outlives the window: the log is written in the main process, so a
  // reload (or a restart) reads back what already ran instead of starting blank.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);
  const [showFinished, setShowFinished] = useState(true);

  const chats = Object.entries(sessions).filter(([, st]) => st.isStreaming);
  // THIS chat first. A panel that mixed every chat's tools together answered a
  // question nobody asked — what is the machine doing — over the one they did:
  // what is happening in front of me. Work in other chats is still here, in its
  // own group, because it is the reason to go and look at them.
  const mine = tasks.filter((t) => t.sessionId === currentSessionId);
  const running = mine.filter((t) => t.status === "running");
  const finished = mine.filter((t) => t.status !== "running");
  const elsewhere = tasks.filter(
    (t) => t.sessionId !== currentSessionId && t.status === "running",
  );
  // A running row shows elapsed time; tick so it doesn't sit frozen. The panel
  // only exists while its tab is open, so having rows to tick is the whole gate.
  const [, force] = useState(0);
  useEffect(() => {
    if (running.length === 0) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running.length]);

  return (
    <div className="space-y-3 p-3">
            {chats.length > 0 && (
              <div className="space-y-1">
                <div className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Running chats
                </div>
                {chats.map(([id, st]) => (
                  <div
                    key={id}
                    className="group/chat flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                  >
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-green-text" />
                    <button
                      type="button"
                      onClick={() => onOpen(id)}
                      className="min-w-0 flex-1 truncate text-left text-[13px]"
                    >
                      {chatLabel(st.messages)}
                      {id === currentSessionId && (
                        <span className="ml-1 text-[11px] text-muted-foreground">
                          · viewing
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      title="Stop"
                      onClick={(e) => {
                        e.stopPropagation();
                        void api()?.chat.abort(id);
                      }}
                      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover/chat:opacity-100"
                    >
                      <Square className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {running.length > 0 && (
              <div className="space-y-1.5">
                <div className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Running
                </div>
                {running.map((t) => (
                  <TaskRow key={t.id} task={t} />
                ))}
              </div>
            )}

            {elsewhere.length > 0 && (
              // Named rather than merged in: the row looks the same, and without
              // a heading you would think this chat was doing it.
              <div className="space-y-1.5">
                <div className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  From other sessions
                </div>
                {elsewhere.map((t) => (
                  <TaskRow key={t.id} task={t} />
                ))}
              </div>
            )}

            {finished.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between px-1">
                  <button
                    type="button"
                    onClick={() => setShowFinished((v) => !v)}
                    className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
                  >
                    Finished {finished.length}
                    {showFinished ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={clearTasks}
                    className="text-[12px] text-muted-foreground hover:text-foreground"
                  >
                    Clear
                  </button>
                </div>
                {showFinished &&
                  finished.map((t) => <TaskRow key={t.id} task={t} />)}
              </div>
            )}

            {chats.length === 0 && tasks.length === 0 && (
              <div className="px-2 py-8 text-center text-[13px] text-muted-foreground">
                Nothing has run yet. Tool calls show up here as they happen.
              </div>
            )}
    </div>
  );
}
