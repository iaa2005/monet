import { useState } from "react";
import { Check, ChevronDown, ChevronUp, HelpCircle, X } from "@/components/icons/hg";
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
      <div className="glass-panel overflow-hidden rounded-xl border border-border bg-card shadow-lg">
        {/* Header — always visible; click to collapse/expand. */}
        <div className="flex items-center gap-2 px-3 py-2">
          <HelpCircle className="size-4 shrink-0 text-brand" />
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
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
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
                    <div className="mb-1 flex items-baseline gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
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
                            className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                              selected
                                ? "border-brand/50 bg-brand-wash"
                                : "border-border hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                            }`}
                          >
                            <span
                              className={`mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors ${
                                multi ? "rounded-[5px]" : "rounded-full"
                              } ${
                                selected
                                  ? "border-brand bg-brand text-white"
                                  : "border-muted-foreground/40"
                              }`}
                            >
                              {selected && (
                                <Check className="size-3" strokeWidth={3} />
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
                        className={`rounded-lg border px-3 py-2 transition-colors ${
                          a.other.trim()
                            ? "border-brand/50 bg-brand-wash"
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
              {/* Same pair as the plan card: bordered secondary, brand-blue
                  primary — answering questions and approving a plan are the
                  same "hand the turn back" moment. */}
              <button
                type="button"
                onClick={onCancel}
                className="rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
              >
                Dismiss
              </button>
              <button
                type="button"
                disabled={!allAnswered}
                onClick={submit}
                className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Submit
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
