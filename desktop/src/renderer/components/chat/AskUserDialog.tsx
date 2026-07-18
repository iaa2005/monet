import { useState } from "react";
import { ChevronDown, ChevronUp, HelpCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  AskUserRequest,
  AskUserAnswer,
  AskUserQuestionSpec,
  AskUserOption,
} from "@/types/electron";

interface AskUserDialogProps {
  request: AskUserRequest;
  onSubmit: (answers: AskUserAnswer[]) => void;
  onCancel: () => void;
}

interface QAState {
  labels: string[];
  other: string;
}

/**
 * Inline, collapsible question panel. It sits just ABOVE the composer (not a
 * full-screen modal), so the chat stays scrollable while the user prepares an
 * answer, and can be collapsed to free up reading space.
 */
export function AskUserDialog({
  request,
  onSubmit,
  onCancel,
}: AskUserDialogProps): JSX.Element {
  const [state, setState] = useState<QAState[]>(
    request.questions.map(() => ({ labels: [], other: "" })),
  );
  const [collapsed, setCollapsed] = useState(false);

  const q = request.questions;

  const toggleOption = (qi: number, label: string, multi: boolean): void => {
    setState((prev) =>
      prev.map((a, i) => {
        if (i !== qi) return a;
        if (multi) {
          const has = a.labels.includes(label);
          return {
            ...a,
            labels: has
              ? a.labels.filter((l) => l !== label)
              : [...a.labels, label],
          };
        }
        return { labels: [label], other: "" };
      }),
    );
  };

  const setOther = (qi: number, text: string, multi: boolean): void => {
    setState((prev) =>
      prev.map((a, i) =>
        i === qi ? { other: text, labels: multi ? a.labels : [] } : a,
      ),
    );
  };

  const isAnswered = (a: QAState): boolean =>
    a.labels.length > 0 || a.other.trim().length > 0;
  const answeredCount = state.filter(isAnswered).length;
  const allAnswered = answeredCount === q.length;

  const submit = (): void => {
    const answers: AskUserAnswer[] = q.map(
      (question: AskUserQuestionSpec, i: number) => ({
        header: question.header,
        question: question.question,
        selected: [
          ...state[i].labels,
          ...(state[i].other.trim() ? [state[i].other.trim()] : []),
        ],
      }),
    );
    onSubmit(answers);
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-1">
      <div className="glass-panel overflow-hidden rounded-xl border border-primary/40 bg-background shadow-lg ring-1 ring-primary/10">
        {/* Header — always visible; click to collapse/expand. */}
        <div className="flex items-center gap-2 px-3 py-2">
          <HelpCircle className="size-4 shrink-0 text-primary" />
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            title={collapsed ? "Expand" : "Collapse"}
          >
            <span className="truncate text-sm font-medium">
              Code Monet needs your input
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {allAnswered
                ? "ready"
                : `${answeredCount}/${q.length} answered`}
            </span>
            {collapsed ? (
              <ChevronUp className="ml-auto size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronDown className="ml-auto size-4 shrink-0 text-muted-foreground" />
            )}
          </button>
          <button
            type="button"
            onClick={onCancel}
            title="Dismiss"
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>

        {!collapsed && (
          <>
            <div className="max-h-[46vh] space-y-5 overflow-y-auto border-t px-4 py-3">
              {q.map((question: AskUserQuestionSpec, qi: number) => {
                const multi = question.multiSelect;
                const a = state[qi];
                return (
                  <div key={qi}>
                    <div className="mb-2 flex items-center gap-2">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {question.header}
                      </span>
                      {multi && (
                        <span className="text-[11px] text-muted-foreground">
                          choose any
                        </span>
                      )}
                    </div>
                    <p className="mb-2 text-sm font-medium">
                      {question.question}
                    </p>
                    <div className="space-y-1.5">
                      {question.options.map((opt: AskUserOption) => {
                        const selected = a.labels.includes(opt.label);
                        return (
                          <button
                            key={opt.label}
                            type="button"
                            onClick={() => toggleOption(qi, opt.label, multi)}
                            className={`flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                              selected
                                ? "border-primary bg-primary/10"
                                : "border-border hover:bg-muted"
                            }`}
                          >
                            <span
                              className={`mt-0.5 flex size-4 shrink-0 items-center justify-center border ${
                                multi ? "rounded-sm" : "rounded-full"
                              } ${
                                selected
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-muted-foreground/40"
                              }`}
                            >
                              {selected && (
                                <span className="text-[10px] leading-none">
                                  ✓
                                </span>
                              )}
                            </span>
                            <span>
                              <span className="font-medium">{opt.label}</span>
                              {opt.description && (
                                <span className="block text-xs text-muted-foreground">
                                  {opt.description}
                                </span>
                              )}
                            </span>
                          </button>
                        );
                      })}

                      <div
                        className={`rounded-md border px-3 py-2 ${
                          a.other.trim()
                            ? "border-primary bg-primary/10"
                            : "border-border"
                        }`}
                      >
                        <label className="block text-xs text-muted-foreground">
                          Other
                        </label>
                        <input
                          type="text"
                          value={a.other}
                          placeholder="Type a custom answer…"
                          onChange={(e) => setOther(qi, e.target.value, multi)}
                          className="mt-1 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end gap-2 border-t px-4 py-3">
              <Button variant="ghost" size="sm" onClick={onCancel}>
                Dismiss
              </Button>
              <Button
                variant="default"
                size="sm"
                disabled={!allAnswered}
                onClick={submit}
              >
                Submit
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
