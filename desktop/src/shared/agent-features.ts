/**
 * What the harness does FOR the model — as a list you can switch off.
 *
 * Everything here exists for one reason: a weak model fails at deciding
 * WHEN, not at doing. It can read a file and fix a named error; it cannot
 * reliably decide that now is the moment to read rather than write. So the
 * harness takes those decisions away from it — a verification that happens
 * to it, a first turn with no writing tools, a reviewer it did not ask for.
 *
 * The catch is that every one of these costs tokens on turns where it was
 * not needed, and a feature nobody can turn off is a feature people turn
 * the whole app off to escape. Hence this list, and hence the honesty of
 * the descriptions: each says what it costs as well as what it buys.
 *
 * Ids are stable — they are keys in `<dataDir>/agent-features.json`.
 * Anything not named here is ignored on read, so an old file cannot switch
 * on something that no longer exists.
 */

export type FeatureId =
  // ── Habits: prompt blocks, paid on every turn ──
  | "method"
  | "discipline"
  // ── Recovery: the harness catching a run that lost the thread ──
  | "nudge"
  | "budget"
  | "loops"
  // ── Checking the work ──
  | "verify"
  | "judge"
  | "review"
  | "smoke"
  // ── Before the work ──
  | "recon"
  | "clarify"
  // ── Craft ──
  | "design"
  // ── Carrying knowledge between runs ──
  | "lessons"
  | "runNotes";

export interface FeatureSpec {
  id: FeatureId;
  /** Shown on the card. */
  name: string;
  /** One sentence on what it does, one on what it costs. */
  description: string;
  /** lucide-react icon name, resolved in the renderer. */
  icon: string;
  group: "Habits" | "Before the work" | "Checking the work" | "Recovery" | "Between runs";
  /** Off by default only where the cost is real and the win situational. */
  defaultOn: boolean;
  /** Roughly what turning it on adds per turn, in the user's terms. */
  cost: "free" | "tokens" | "time";
}

export const FEATURES: FeatureSpec[] = [
  {
    id: "method",
    name: "Method",
    description:
      "Eight lines of working order in the system prompt: ground truth before a plan, cause before fix, evidence before claim. The habits that separate careful work from confident guessing. Costs ~200 tokens on every turn.",
    icon: "Compass",
    group: "Habits",
    defaultOn: true,
    cost: "tokens",
  },
  {
    id: "discipline",
    name: "Working discipline",
    description:
      "The prohibitions: read before you edit, never commit without running the checks, no blind `git add -A`, the same error twice means the approach is wrong. Spelled out as imperatives a weak model can follow.",
    icon: "ShieldCheck",
    group: "Habits",
    defaultOn: true,
    cost: "tokens",
  },
  {
    id: "recon",
    name: "Look before you write",
    description:
      "Nothing happens until the model tries to change a file without having read anything. That one call is refused, once per run, and the phase opens: reading tools only, and its answer is a plan. A model that reads first never notices this exists — it costs nothing until it is needed.",
    icon: "Telescope",
    group: "Before the work",
    defaultOn: false,
    cost: "time",
  },
  {
    id: "clarify",
    name: "Ask when it is ambiguous",
    description:
      "On the first message of a chat, a fresh context reads the request alone and answers: clear, or these questions first. If it says ambiguous, the harness asks — the model never has to decide to interrupt. Nothing filters the request before the reader sees it, so it works the same in any language. One short model call per chat.",
    icon: "MessageCircleQuestion",
    group: "Before the work",
    defaultOn: false,
    cost: "tokens",
  },
  {
    id: "verify",
    name: "Run the project's checks",
    description:
      "After a turn that edited files, the harness runs the checks the project already declares (typecheck, lint) and, when one fails, starts another turn with the failure as the prompt. The model never decides whether to verify.",
    icon: "CircleCheck",
    group: "Checking the work",
    defaultOn: true,
    cost: "time",
  },
  {
    id: "smoke",
    name: "Actually run it",
    description:
      "Checks that the thing WORKS, not just that it compiles: start the dev server, open the page, collect console and network errors, and hand them back as the next prompt. Catches the class of bug a typecheck never sees.",
    icon: "PlayCircle",
    group: "Checking the work",
    defaultOn: false,
    cost: "time",
  },
  {
    id: "review",
    name: "A second reader",
    description:
      "A sub-agent with a fresh context reads the diff and must produce findings or say plainly that there are none. It never shared the author's reasoning, which is the whole point. One extra model call per turn that edited files.",
    icon: "Eye",
    group: "Checking the work",
    defaultOn: false,
    cost: "tokens",
  },
  {
    id: "judge",
    name: "Judge the completion claim",
    description:
      "\"Done\" is the least reliable sentence a cheap model writes — it is graded by someone who shared every step of its reasoning. Before a goal closes, the full checks run and a fresh context reads the evidence instead.",
    icon: "Gavel",
    group: "Checking the work",
    defaultOn: true,
    cost: "tokens",
  },
  {
    id: "design",
    name: "Interface standards",
    description:
      "A checklist a weak model can actually follow instead of \"make it nice\": one spacing scale, one accent colour, four states on every control, an empty and an error state for every list, visible keyboard focus.",
    icon: "Palette",
    group: "Habits",
    defaultOn: false,
    cost: "tokens",
  },
  {
    id: "nudge",
    name: "Nudge an empty reply",
    description:
      "A reply with no text and no tool call is a model that lost the thread, but the loop reads it as \"finished\" and the chat simply stops. The harness sends the nudge you would have sent by hand. Twice per run at most.",
    icon: "Wind",
    group: "Recovery",
    defaultOn: true,
    cost: "free",
  },
  {
    id: "loops",
    name: "Catch a loop",
    description:
      "When one exact call repeats with identical input, the model is told mid-run — from inside, every identical result looks like one more datum rather than a mirror. Can misread patient work (data entry, retries you asked for) as being stuck; switch it off if the notes annoy more than they save.",
    icon: "Repeat",
    group: "Recovery",
    defaultOn: true,
    cost: "free",
  },
  {
    id: "budget",
    name: "Land the plane",
    description:
      "Ten steps before the run's real end — extensions it is on course to earn included — the model is told how many are left, so it converges instead of opening a new thread. After the last step it gets a turn with no tools: it can no longer act, but it can still say what happened.",
    icon: "PlaneLanding",
    group: "Recovery",
    defaultOn: true,
    cost: "free",
  },
  {
    id: "lessons",
    name: "Learn from failures",
    description:
      "Failed tool calls, chats that ended on an error and goals that ran out of budget are distilled overnight into a short list of lessons, injected into every later chat in THAT folder. One model call a night, per workspace.",
    icon: "GraduationCap",
    group: "Between runs",
    defaultOn: true,
    cost: "free",
  },
  {
    id: "runNotes",
    name: "Notes for the next run",
    description:
      "A goal that finishes writes what it did; one that blocks writes what stopped it. The next run in the same folder starts with those lines, so it neither redoes the work nor walks into the same wall. Costs nothing.",
    icon: "NotebookPen",
    group: "Between runs",
    defaultOn: true,
    cost: "free",
  },
];

export const FEATURE_IDS: FeatureId[] = FEATURES.map((f) => f.id);

export type FeatureFlags = Record<FeatureId, boolean>;

export function defaultFeatures(): FeatureFlags {
  const out = {} as FeatureFlags;
  for (const f of FEATURES) out[f.id] = f.defaultOn;
  return out;
}

/**
 * A stored (or hand-edited) object, made safe.
 *
 * Unknown keys are dropped rather than kept: the file is meant to be
 * readable and editable, and a typo that silently becomes a live flag is
 * how you end up debugging a feature nobody enabled.
 */
export function sanitiseFeatures(raw: unknown): FeatureFlags {
  const out = defaultFeatures();
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const f of FEATURES) {
    const v = obj[f.id];
    if (typeof v === "boolean") out[f.id] = v;
  }
  return out;
}
