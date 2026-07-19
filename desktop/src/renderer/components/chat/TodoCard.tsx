/**
 * Todo card — a collapsible plan view above the chat.
 *
 * The agent maintains its plan with the TodoWrite tool; the LATEST TodoWrite
 * call in the conversation is the current state of the plan, so the card is
 * derived straight from the message list: it appears when a plan exists,
 * updates on every TodoWrite, and disappears when the list is cleared.
 */

import { useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  Circle,
  ListTodo,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types/chat";

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | string;
  activeForm?: string;
}

function latestTodos(messages: ChatMessage[]): TodoItem[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const tc = messages[i].toolCall;
    if (tc?.name === "TodoWrite") {
      const todos = (tc.input as { todos?: TodoItem[] } | undefined)?.todos;
      return Array.isArray(todos) && todos.length > 0 ? todos : null;
    }
  }
  return null;
}

function StatusIcon({ status }: { status: string }): JSX.Element {
  if (status === "completed")
    return <Check className="size-3.5 shrink-0 text-green-text" />;
  if (status === "in_progress")
    return (
      <Loader2 className="size-3.5 shrink-0 animate-spin text-link" />
    );
  return <Circle className="size-3 shrink-0 text-muted-foreground/50" />;
}

export function TodoCard({
  messages,
}: {
  messages: ChatMessage[];
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const todos = useMemo(() => latestTodos(messages), [messages]);
  if (!todos) return null;

  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress");

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-2">
      <div className="overflow-hidden rounded-xl border border-border bg-card/60">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <ListTodo className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-[13px] font-medium">
            Todos · {done}/{todos.length}
          </span>
          {!open && current && (
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
              {current.activeForm || current.content}
            </span>
          )}
          {/* Mini progress bar */}
          <span className="ml-auto h-1 w-16 shrink-0 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.1]">
            <span
              className="block h-full rounded-full bg-green-text transition-[width]"
              style={{ width: `${Math.round((done / todos.length) * 100)}%` }}
            />
          </span>
        </button>

        {open && (
          <div className="border-t border-border px-3 py-1.5">
            {todos.map((t, i) => (
              <div
                key={`${i}-${t.content.slice(0, 24)}`}
                className="flex items-center gap-2 py-1"
              >
                <StatusIcon status={t.status} />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[13px]",
                    t.status === "completed" &&
                      "text-muted-foreground line-through decoration-muted-foreground/40",
                    t.status === "in_progress" && "text-foreground",
                    t.status === "pending" && "text-muted-foreground",
                  )}
                >
                  {t.status === "in_progress"
                    ? t.activeForm || t.content
                    : t.content}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
