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
  "Glob",
  "Read",
  "ObsidianSearch",
  "ObsidianRead",
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
  // "Harness note, not from the user" is not decoration. This block is
  // appended to the user's own message, and a model asked to translate a long
  // text replied with the translation and then this, verbatim: "the second part
  // of your message looks like an instruction for a coding task — it does not
  // relate to the translation". It attributed the harness's words to the user
  // and tried to satisfy them. Provenance has to be on the block itself.
  "[Harness note, not from the user — reconnaissance phase. The writing tools",
  "are not available this phase. Nothing below is part of the user's request.]",
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
  "[Harness note, not from the user — reconnaissance over, every tool is",
  "available again.]",
  "",
  "Now do the work, following the plan you just wrote. If what you find",
  "contradicts it, say so and adjust rather than forcing it through.",
].join("\n");

/** Ran out of looking without producing a plan. */
export const RECON_TIMEUP = [
  "[Harness note, not from the user — reconnaissance is over,",
  `${RECON_TURNS} looking turns is the limit.]`,
  "",
  "Say what you found and what you will do, then carry on with the work.",
  "Every tool is available again.",
].join("\n");

/**
 * Which calls "read it first" is even ABOUT.
 *
 * This used to be writers.ts's WRITERS, and that set answers a different
 * question — "could this batch have changed the folder", asked so a rewind
 * does not miss a file. Under it, `RunPython` counts as a writer, and in Home
 * the very first thing a chat does is RunPython: the sandbox starts empty, the
 * data comes off the network, and there is nothing to have read. Every Home
 * chat opened with a refusal, six read-only turns, and a Glob answering
 * "sandbox is empty". Measured on "нарисуй график Apple": two wasted turns
 * before the work started, on a task with no files in it at all.
 *
 * The condition the note actually states is "you are about to overwrite
 * something you have not seen". That is these four tools, and only when the
 * target is already there — see targetExists in the loop. Running a command is
 * not on the list: `git status`, `npm test` and a yfinance download are not
 * blind writes, and a run's first action being a command is ordinary.
 */
export const LOOK_FIRST_TOOLS = new Set([
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Write",
]);

/**
 * Refusing a tool the recon phase does not offer.
 *
 * The phase hands the model a reduced toolset, which is not the same as
 * enforcing it: a model that called RunPython last turn calls it again from
 * memory, and the executor looked the name up in the FULL registry and ran it.
 * So the writing tools were "taken away" in the sense that they were not
 * listed, and available in the sense that they worked — the run did its whole
 * job inside the looking phase, and the answer that followed was then read as
 * the plan and handed back with "now do the work". The user's word for the
 * result was "ЧТО? КАААК?".
 */
export function reconRefusal(toolName: string): string {
  return [
    "[Harness note, not from the user — reconnaissance phase.]",
    "",
    `${toolName} is not available while looking. This phase is for reading:`,
    "Read, Grep, Glob, WebFetch, WebSearch, TodoWrite, AskUserQuestion.",
    "",
    "When you know enough, stop calling tools and write out the plan — every",
    "tool comes back the moment you do.",
  ].join("\n");
}

/**
 * Nothing here predicts anything from the user's words any more.
 *
 * There used to be `worthRecon`: English action verbs, a few Russian stems, and
 * a length test. Measured live against DeepSeek with one brief written five ways
 * — "add a limit to the list in list.js" — it produced three levels of service:
 *
 *     en  34 chars  phase ran        31.5s, 8 tools
 *     ru  37        phase ran        28.3s, 8 tools   (a stem added that morning)
 *     tr  39        nothing          10.2s, 4 tools
 *     de  47        nothing          10.2s, 4 tools
 *     zh  19        nothing          10.2s, 4 tools
 *
 * Same task, same file, same fix, and the three languages nobody had typed into
 * the regex finished it in a third of the time. Before that, the same heuristic
 * fired on "переведи <two thousand characters>" because the payload tripped the
 * length test, and the loop then told the model to carry out the plan it had
 * supposedly written; it searched GitHub for ten turns.
 *
 * The condition the phase exists for needs no language: a write is about to
 * happen and nothing has been read. That is observable at the moment of the
 * call — see LOOK_FIRST_NOTE and the guard in the loop — and in every live run
 * measured so far it would not have fired once, because a read preceded every
 * write. Which is the point: the phase now costs nothing until it is needed.
 */

/**
 * What a blind write is answered with, and what opens the phase.
 *
 * Refused as an error on purpose: a note attached to a successful result reads as
 * commentary and gets skipped, while a failed call is something that has to be
 * dealt with. Once per run — a guard that can fire twice is a guard that can
 * become a loop.
 */
export const LOOK_FIRST_NOTE = [
  "[Harness note, not from the user — refused once per run, and only this once.]",
  "",
  "This is the first thing this run does to the folder, and nothing has been read",
  "yet. Read the file you are about to change, then make the same call again.",
  "Writing into a file whose current contents you have not seen is how a run",
  "spends twenty turns undoing its own first guess.",
].join("\n");

/**
 * Did the reconnaissance phase produce a PLAN, or just an answer?
 *
 * The loop ends recon when the model stops calling tools, on the reasoning that
 * in a normal turn "no tool calls" means finished and in recon it means the
 * looking is over. Both readings are available for the same evidence, and it
 * picked the wrong one for every request that needed no looking at all: a model
 * that answered outright was told it had written a plan, and asked to carry it
 * out. It had not read a single file — which is exactly what distinguishes the
 * two cases, and it was there to be counted the whole time.
 */
export function planWasMade(reconToolCalls: number): boolean {
  return reconToolCalls > 0;
}
