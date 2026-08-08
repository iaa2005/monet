/**
 * Ask when it is ambiguous.
 *
 * A weak model does not ask questions. Not because it understood — because
 * asking is a decision, and by the time it could make it, it is already
 * writing. Telling it in the system prompt to "ask when unsure" does not
 * work either: unsure is a feeling it does not reliably have.
 *
 * So the question is taken away from it. Before the first edit, the request
 * alone — no code, no conversation, no plan already formed — goes to a
 * fresh context whose only job is to answer one thing: could a competent
 * developer read this two ways and build two different things? If yes, the
 * HARNESS asks, with the app's own multiple-choice dialog, and the answers
 * ride into the run as part of the brief.
 *
 * The bar is deliberately high. Every question spends the user's attention,
 * which is the most expensive thing here — more than tokens, more than
 * turns — so "ask about anything unclear" would be worse than never asking.
 * Two readings that lead to DIFFERENT WORK, or nothing.
 *
 * Pure: the prompt and the parsing are the whole contract. No electron.
 */

export interface ClarifyQuestion {
  /** The chip label — two or three words. */
  header: string;
  /** The question as it is put to the user. */
  question: string;
  /** The readings, as choices. Always at least two. */
  options: string[];
}

export interface ClarifyOutcome {
  status: "clear" | "ask" | "skipped";
  questions: ClarifyQuestion[];
  reason?: string;
}

/** At most this many, ever. A dialog with five questions is a form. */
export const MAX_QUESTIONS = 2;

export function clarifyPrompt(request: string): string {
  return [
    "You are reading a request that somebody is about to hand to a coding",
    "agent. You are not doing the work and you cannot see the code.",
    "",
    "One question only: could a competent developer read this two ways and",
    "build two DIFFERENT things? Not \"is there detail missing\" — there",
    "always is, and it can be discovered by reading the code. Only a fork",
    "where guessing wrong means the work is wasted.",
    "",
    "If there is no such fork — the overwhelmingly common case — answer with",
    "exactly:",
    "",
    "CLEAR",
    "",
    `Otherwise ask at most ${MAX_QUESTIONS} questions, each in exactly this shape,`,
    "one per line, and nothing else:",
    "",
    "ASK <2-3 word label> | <the question> | <option> | <option>",
    "",
    "Two to four options, each a concrete choice a person can pick, not",
    "\"other\" or \"it depends\". Prefer CLEAR when you are hesitating.",
    "",
    "----- the request -----",
    request,
  ].join("\n");
}

/**
 * Read the answer.
 *
 * Anything that is not a well-formed question is not a question. A parser
 * that salvages half a line produces a dialog asking half a question, and
 * the user's attention is exactly what this is spending — better to skip
 * than to spend it badly.
 */
export function parseClarify(text: string): ClarifyOutcome {
  const questions: ClarifyQuestion[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[\s>*\-\d.)]+/, "").trim();
    const m = /^ASK\s+(.+)$/i.exec(line);
    if (!m) continue;
    const parts = m[1]
      .split("|")
      .map((s) => s.replace(/[*`]/g, "").trim())
      .filter(Boolean);
    const [header, question, ...options] = parts;
    // A label, a question and at least two things to choose between. Anything
    // short of that is half a question, and half a question put to a person
    // is worse than not interrupting them.
    if (!header || !question || options.length < 2) continue;
    questions.push({
      header: header.slice(0, 12),
      question,
      options: options.slice(0, 4),
    });
    if (questions.length >= MAX_QUESTIONS) break;
  }
  if (questions.length > 0) return { status: "ask", questions };
  if (/\bCLEAR\b/i.test(text)) return { status: "clear", questions: [] };
  // Neither: the reader did not answer the question it was asked. Not a
  // reason to interrupt the user, and not a reason to claim it is clear.
  return { status: "skipped", questions: [], reason: "no usable answer" };
}

/** What rides into the run with the user's own words. */
export function answersNote(
  answers: { question: string; selected: string[] }[],
): string {
  return [
    "[Answered before the work started:]",
    ...answers.map((a) => `- ${a.question} → ${a.selected.join(", ")}`),
  ].join("\n");
}

/**
 * Is this request worth a reader's call at all?
 *
 * The same shape as recon's test, and for the same reason: a greeting, a
 * one-word follow-up or a question about the code is not a brief, and
 * putting a dialog in front of one is how a feature gets switched off. A
 * follow-up inside an existing conversation is excluded by the caller —
 * ambiguity there is resolved by everything already said.
 */
const ACTION = /\b(add|build|change|create|fix|implement|make|migrate|move|refactor|remove|rename|rewrite|update|write|delete|port|wire|support|integrate)\b/i;

export function worthClarifying(prompt: string): boolean {
  const text = prompt.trim();
  if (text.length < 24) return false;
  return ACTION.test(text) || text.length > 120;
}
