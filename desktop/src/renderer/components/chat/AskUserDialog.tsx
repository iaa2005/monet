import { useState } from "react";
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

const OTHER = "__other__";

export function AskUserDialog({
  request,
  onSubmit,
  onCancel,
}: AskUserDialogProps): JSX.Element {
  const [state, setState] = useState<QAState[]>(
    request.questions.map(() => ({ labels: [], other: "" })),
  );

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
        // Single-select: pick replaces and clears any "Other" text.
        return { labels: [label], other: "" };
      }),
    );
  };

  const setOther = (qi: number, text: string, multi: boolean): void => {
    setState((prev) =>
      prev.map((a, i) =>
        i === qi
          ? { other: text, labels: multi ? a.labels : [] }
          : a,
      ),
    );
  };

  const isAnswered = (a: QAState): boolean =>
    a.labels.length > 0 || a.other.trim().length > 0;
  const allAnswered = state.every(isAnswered);

  const submit = (): void => {
    const answers: AskUserAnswer[] = q.map((question: AskUserQuestionSpec, i: number) => ({
      header: question.header,
      question: question.question,
      selected: [
        ...state[i].labels,
        ...(state[i].other.trim() ? [state[i].other.trim()] : []),
      ],
    }));
    onSubmit(answers);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border bg-background shadow-lg">
        <div className="border-b px-6 py-4">
          <h3 className="text-lg font-semibold">A quick question</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Claude needs your input to continue.
          </p>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-4">
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
                <p className="mb-2 text-sm font-medium">{question.question}</p>
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
                            <span className="text-[10px] leading-none">✓</span>
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

                  {/* Free-text "Other" — always available. */}
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
                      data-other={OTHER}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 border-t px-6 py-4">
          <Button variant="ghost" onClick={onCancel}>
            Dismiss
          </Button>
          <Button variant="default" disabled={!allAnswered} onClick={submit}>
            Submit
          </Button>
        </div>
      </div>
    </div>
  );
}
