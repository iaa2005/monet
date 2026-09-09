/**
 * Which of the app's OWN tools are held back until they are asked for.
 *
 * ToolSearch was built for MCP, where a connector can bring twenty tools
 * nobody will use today. The app's own toolset has the same shape and nobody
 * had noticed: measured on a Code turn, thirty-three tools cost 15,274 tokens
 * of description and schema, and a third of that is capability the average
 * message never touches — six Obsidian tools, the routine editor, the skill
 * writer, the swarm, the team channel. On an API that is a few cents a turn.
 * On a model running from system memory, where the prompt is read at ten
 * tokens a second, five thousand tokens is eight minutes of waiting before
 * the first word — every turn, whether or not a note was ever mentioned.
 *
 * A deferred tool is not a missing one. Its NAME and its one-line hint go
 * into the inventory the model is given (deferred-inventory.ts), and one
 * ToolSearch call brings the real schema back. The hint is the tool's own
 * `searchHint`, which every one of these already carries — a second list of
 * prose would only be a second thing to keep in step.
 *
 * WHAT IS NOT HERE is the interesting half:
 *
 *   - Read, Edit, Write, Glob, Grep, Bash, PowerShell, TodoWrite, Task —
 *     the working set. A turn that had to search for Read would be worse in
 *     every way than one that paid for it.
 *   - EnterPlanMode / ExitPlanMode / UpdatePlan. Plan mode ENDS by calling
 *     ExitPlanMode; a mode whose exit has to be searched for is a trap. They
 *     want gating by mode, which is a different mechanism, not deferral.
 *   - DeliverFiles. It is how Home hands over what it made, at the end of a
 *     turn, when the model is least likely to go looking for a tool.
 *   - AskUserQuestion, Skill, SearchPastChats, Remember — small, and each is
 *     something the model must think of on its own or not at all.
 *   - Connector tools (Mail, Drive, …). They appear only once the user has
 *     signed an account in, which is as good as asking for them.
 */

/**
 * The pseudo-server these are announced under.
 *
 * The inventory groups by server because that is what MCP has. These belong
 * to the app itself, so they get one group of their own rather than being
 * scattered through a list of vendors — and the name is the label, so the
 * line reads "built-in: …" rather than repeating itself.
 */
export const BUILT_IN_GROUP = "built-in";

const NAMES = [
  // The user's notes. Six tools, 1,643 tokens, and every one of them is
  // dead weight in a chat that never mentions a vault.
  "ObsidianSearch",
  "ObsidianRead",
  "ObsidianWrite",
  "ObsidianEdit",
  "ObsidianAttach",
  "ObsidianMove",
  // Scheduling, skills, swarms, the team channel: real capabilities, asked
  // for by name when they are wanted.
  "Routine",
  "CreateSkill",
  "AgentSwarm",
  "SendMessage",
  "TeamList",
  // Reading a picture off disk. The attachments a user drags into the chat
  // do not come through here — they arrive as content blocks.
  "ReadMediaFile",
  // Only meaningful inside an autonomous goal.
  "UpdateGoal",
  // Opt-in already, and only about code intelligence.
  "LSP",
  // Only for .ipynb.
  "NotebookEdit",
  // Home: adding a toolchain to the sandbox image is a once-a-project act.
  "SandboxImage",
  // Only once a model is on disk, and only for scanning a document.
  "OCRScan",
] as const;

export const DEFERRABLE_TOOLS: ReadonlySet<string> = new Set<string>(NAMES);

/** Whether this tool may be held out of the standing schema. */
export function isDeferrable(name: string): boolean {
  return DEFERRABLE_TOOLS.has(name);
}
