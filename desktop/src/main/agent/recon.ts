/**
 * Look before you write.
 *
 * The most expensive habit a weak model has is starting. Told to add a
 * feature it opens a file it has not read and writes into it, and the
 * twenty turns that follow are spent discovering what the first read would
 * have told it. Asking it nicely does not work — the system prompt already
 * says "ground truth first", and it agrees, and then it writes.
 *
 * So the first turns of a task run with the writing tools TAKEN AWAY. Not
 * a rule it can weigh against its own confidence: a toolset in which
 * starting to code is not an available action. It reads, greps, looks at
 * the thing it was asked to change, and when it stops calling tools — which
 * in a normal turn means "done" — that is the plan, and the phase ends.
 * The full toolset comes back with one line saying so.
 *
 * The list is an ALLOW-list, the opposite of writers.ts. There, an unknown
 * tool counts as a writer because guessing "read-only" loses the user's
 * work; here, an unknown tool is dropped for the same reason, and the cost
 * of dropping one too many is only that recon saw a little less.
 *
 * Pure — no electron, no model, no disk. The arithmetic is what a probe
 * pins down.
 */

/** How many read-only turns a recon phase may spend before it must plan. */
export const RECON_TURNS = 6;

/**
 * Tools a reconnaissance turn may use: look, search, ask, take notes.
 *
 * `AskUserQuestion` is here deliberately. If the request is ambiguous, the
 * cheapest possible moment to find out is before anything has been built —
 * and this is the one phase where the model has nothing else it can do.
 */
export const RECON_TOOLS = new Set([
  // Reading the project
  "Read",
  "Grep",
  "Glob",
  "NotebookRead",
  "ToolSearch",
  // Reading the world
  "WebFetch",
  "WebSearch",
  // Reading the sandbox / the vault
  "SandboxList",
  "SandboxRead",
  "VaultSearch",
  "VaultRead",
  // Code intelligence — all read-only by construction
  "LspDefinition",
  "LspReferences",
  "LspHover",
  "LspSymbols",
  "LspDiagnostics",
  // Talking to the user, and to itself
  "AskUserQuestion",
  "TodoWrite",
  "EnterPlanMode",
]);

/** The toolset for a recon turn — everything that cannot change anything. */
export function reconTools<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => RECON_TOOLS.has(t.name));
}

/**
 * What the model is told while it cannot write.
 *
 * Short and concrete: a weak model handed a paragraph about methodology
 * produces a paragraph about methodology. This asks for four things it can
 * actually answer, and says plainly that writing is not available — without
 * that line it spends a turn trying to Edit and reading the refusal.
 */
export const RECON_PROMPT = [
  "[Reconnaissance — the writing tools are not available this phase.]",
  "",
  "Before anything is changed, look. Use the reading tools to find the code",
  "this task actually touches, then answer, briefly:",
  "",
  "1. WHERE it lives — the files and functions involved, by path.",
  "2. HOW it works now — what you read, not what you assume.",
  "3. WHAT you will change, in order, riskiest and most load-bearing first.",
  "4. WHAT could make this the wrong plan — the thing you would check next",
  "   if the first step failed.",
  "",
  "If something about the request is genuinely ambiguous — two readings that",
  "lead to different work — ask now with AskUserQuestion. This is the",
  "cheapest moment there will ever be to ask.",
  "",
  "When you have the answer, stop calling tools and write it out.",
].join("\n");

/** Handed over with the full toolset, so the plan is not orphaned. */
export const RECON_DONE = [
  "[Reconnaissance over — every tool is available again.]",
  "",
  "Now do the work, following the plan you just wrote. If what you find",
  "contradicts it, say so and adjust rather than forcing it through.",
].join("\n");

/** Ran out of looking without producing a plan. */
export const RECON_TIMEUP = [
  `[Reconnaissance is over — ${RECON_TURNS} looking turns is the limit.]`,
  "",
  "Say what you found and what you will do, then carry on with the work.",
  "Every tool is available again.",
].join("\n");

/**
 * Is a reconnaissance phase worth running for this prompt?
 *
 * A greeting, a thank-you or "what does this function do" is not a task,
 * and putting a planning phase in front of it is how a feature earns a
 * reputation for being in the way. The test is deliberately crude — a
 * prompt long enough to be a request for work, or one that names an action
 * — because the cost of a false positive is one read-only turn and the
 * cost of a false negative is the thing this exists to prevent. A bug
 * report often names no action at all — it describes what HAPPENS — so
 * length counts on its own, at about the point where prose stops being a
 * remark and starts being a brief.
 */
const ACTION = /\b(add|build|change|create|fix|implement|make|migrate|move|refactor|remove|rename|rewrite|update|write|delete|port|wire|hook up|support|integrate)\b/i;

export function worthRecon(prompt: string): boolean {
  const text = prompt.trim();
  if (text.length < 24) return false;
  return ACTION.test(text) || text.length > 120;
}
