---
title: The harness around the model
description: The scaffolding that budgets, verifies, unsticks and compacts a run — with every threshold it uses.
order: 13
---

A model turn does not run naked. Around it sits a harness that budgets its
steps, checks its work, notices when it is stuck, and keeps the context
window from overflowing. When the harness overrides the model you see a slim
grey line in the transcript — an extra turn you did not ask for is always
explained.

## Every switch on one screen

*Settings → Advanced → How the agent works.* What fires it, on what evidence,
what it costs when it was not needed. **No row keys off the words in your
request** — that was tried and it served English and nothing else.

| Switch | Fires when | Cost when unnecessary |
| --- | --- | --- |
| **Method** · on | always — 8 lines in the system prompt | ~200 tokens per turn |
| **Working discipline** · on | always — the prohibitions, as imperatives | ~200 tokens per turn |
| **Look before you write** · off | the model tries to change a file having read nothing. That call is refused once per run and the read-only phase opens | nothing — a model that reads first never sees it |
| **Ask when it is ambiguous** · off | first message of a chat. A fresh context reads it and answers CLEAR or two questions | one short model call per chat |
| **Run the project's checks** · on | a turn edited files. Failure text becomes the next prompt, ≤3 attempts | the time the checks take |
| **Actually run it** · off | a turn edited files — starts the app, collects console and network errors | a dev-server start |
| **A second reader** · off | a turn edited files — a sub-agent reads the diff with no shared reasoning | one model call per editing turn |
| **Judge the completion claim** · on | the model says it finished | one short model call |
| **Interface standards** · off | always, when the turn touches UI | tokens in the prompt |
| **Nudge an empty reply** · on | a reply with no text and no tool call. ≤2 per run, never twice running | one turn |
| **Land the plane** · on | 10 steps before the run's real end, extensions included. Then one tool-less turn to hand over | one turn at the end |
| **Learn from failures** · on | overnight, per workspace — failures distilled into lessons | one model call a night |
| **Notes for the next run** · on | a goal finishes or blocks | nothing |

Three switches spend a whole model call — *Ask when it is ambiguous*, *A second
reader*, *Judge the completion claim*. Each of those is a **side agent with its
own context**, and whether it shares the run's context is the design decision,
not an accident: a reader that judges the run's *claims* must not have read the
run's narration, or it inherits its mistakes; a reader that judges your *intent*
needs the conversation, which is why ambiguity is only ever read on the first
message.

## The step budget

Every message gets a fixed number of tool-calling turns. The interesting
part is that the budget **moves, on evidence**:

- Every tool call is recorded as a signature — tool name plus its input.
  Ten clicks on ten different elements is work; ten on the same one is a
  loop.
- Over the last **12** calls, if fewer than **60 %** are distinct, the run
  counts as repeating itself.
- At the wall, a run still doing new things earns **+20** turns — at most
  **twice**. A repeating run earns nothing. The ceiling is therefore hard.
- **10** steps before the run's *real* end the model gets one line — "N steps
  left, start converging" — because a model that was never told about the
  limit spends its steps as if they were free. "Real" end means the budget
  plus the extensions it is on course to earn: measured against the current
  budget instead, a productive run was told "10 left" at turn 30 of 80, warned
  three times over, and once in the same message that had just congratulated
  it for producing new work.
- When the steps run out mid-task, the run gets **one final turn with the
  tools removed**: it cannot act, but it can hand the work over — what is
  done, what is broken, the single next step. Forty turns of findings no
  longer end in silence.

## Loop steering

The same repetition evidence, spoken while there is still time. When one
identical call has run **3+** times in the recent window and the distinct
ratio fell below 60 %, the harness sends a correction straight into the run:
which call repeated, how many times, and that the result will not change.
At most **2** corrections per run, at least **6** calls apart — a nudge that
does not take must not become its own loop. (Both the cap and the skip on
aborted turns are lessons borrowed from little-coder's quality monitor,
which once "corrected" its own cancellations.)

## The empty-reply nudge

A reply with no text and no tool calls is not an answer — it is a model that
lost the thread, and the loop would otherwise read it as "done" and end the
run in silence. The harness sends what a person sends by hand: a bare `"."`.
At most **2** per run, never twice in a row (two empties in a row means the
model is finished or broken, and a third request would only spend money).

## The verification loop

After a turn that edited files, the harness runs the project's own checks —
the model never decides whether to verify, verification happens **to** it.
If a check fails, the failure text becomes the next prompt, up to **3** fix
attempts. Exits are explicit:

| Verdict | Meaning |
| --- | --- |
| `clean` | checks passed on the first run |
| `fixed` | failed, then fixed within budget |
| `gave-up` | attempts exhausted; the failure is shown |
| `known-red` | the same failure twice in a row — it was already broken before this turn, and is remembered so later turns don't trip over somebody else's build |

## Context management

Two layers, cheapest first:

1. **Micro-compaction.** Most of a full context is not conversation, it is
   tool output — a 200 KB file read, a long grep. Output of *replayable*
   tools (Read, Grep, Glob, shell, web fetch…) is cleared first: the model
   can always call them again. Nothing anyone *said* is touched. One-off
   results — a sub-agent's report, your answers to questions — are never
   cleared.
2. **Summarising compaction.** Only if micro-compaction was not enough, the
   older part of the conversation is summarised by the model itself. The
   threshold sits at ~70 % of the model's input budget.

The transcript shows a **context break** line where the model's memory
actually begins; messages above it stay on screen, dimmed — still yours to
read, no longer the model's. The full history is kept on disk regardless
(reopening, forking and rewind use it).

## Interventions you can see

Every one of these paints a slim centered line in the transcript at the
moment it happens:

- "The model answered with nothing — nudged it to continue (1/2)"
- "Going in circles — X ran N× with identical input; asked the model to change approach"
- "Asked it to read before writing (Edit with nothing read yet)"
- "10 steps left — asked the model to start converging"
- "Step budget extended by 20 — the run is still producing new work"
- "Out of steps — asked the model for a handoff summary"
- "Reading the request for anything ambiguous"

These lines are display-only. They are never sent to the model and never
exported as part of the conversation.
