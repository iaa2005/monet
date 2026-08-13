/**
 * Which tools each space may see — the part that is a plain list.
 *
 * Dependency-free on purpose. The rest of `isSpaceToolAllowed` asks whether the
 * user enabled Browser Use, whether a language server is installed, whether
 * there are MCP servers — all of which need main. THIS is the part that answers
 * "does this tool belong in the isolated space", and it is the part that drifts:
 * a tool gets added elsewhere and nobody asks which space it belongs to.
 */

/** Tools advertised to Home (isolated space): no host filesystem, no host
 * shell. Read/Write/Edit/Glob appear here too, but in Home they resolve to
 * the sandbox implementations — getVendorToolsForSpace swaps them, so the
 * model never picks a filesystem by picking a tool name. */
export const HOME_TOOL_NAMES = new Set([
  "RunPython",
  // Long installs and builds run detached via its run_in_background flag;
  // the turn keeps thinking and the finish is announced on its own.
  "RunCommand",
  // Asking for a compiler the image does not have. It cannot install one
  // itself — the container is discarded — and the permission prompt is what
  // makes this safe to offer: the image is shared by every chat.
  "SandboxImage",
  // The same names Code uses. In Home they resolve to the sandbox
  // implementations — see getVendorToolsForSpace.
  "Read",
  "Write",
  "Edit",
  "Glob",
  // Serving the chat's own folder over a loopback-only port, from inside the
  // container — the isolated alternative to DevServer, which is Code's.
  "ServeSandbox",
  // Looking at a picture the sandbox produced crosses no boundary — the path
  // is resolved inside this chat's own folder.
  "ReadMediaFile",
  "TodoWrite",
  "Skill",
  // Running a skill is here, so writing one belongs here too — and Home is
  // where someone is most likely to say "make that a skill". It writes into the
  // app's own skills folder under a validated slug, never a path the model
  // chose, so it crosses the same boundary `Remember` does: the USER's setup,
  // not the machine Home is isolating.
  "CreateSkill",
  "AskUserQuestion",
  // Planning crosses no boundary: the plan document lives in the app's own
  // DB, and entering/leaving plan mode is a permission-mode change, not a
  // filesystem one. Without these, Home could never plan at all.
  "EnterPlanMode",
  "ExitPlanMode",
  "UpdatePlan",
  "WebFetch",
  "WebSearch",
  "SearchPastChats",
  // The Obsidian vault is the USER's knowledge base, not the machine Home
  // isolates — same boundary reasoning as Remember below. ObsidianWrite is
  // still a write outside any workspace, so the permission gate covers it.
  "ObsidianSearch",
  "ObsidianRead",
  "ObsidianWrite",
  // Putting a picture in the vault is the same boundary as writing a note:
  // the SOURCE is resolved inside this chat's own sandbox, the workspace or
  // its artifacts — never a path the model invented.
  "ObsidianEdit",
  "ObsidianAttach",
  "ObsidianMove",
  // Reading a document is looking at a file this chat already has — the
  // source resolver never leaves the sandbox, the workspace or the vault,
  // and the model that reads it runs on this machine.
  "OCRScan",
  // Memory is about the USER, not the filesystem — it belongs in both spaces.
  "Remember",
  // Waiting touches nothing, so it is safe in the isolated space too.
  // Coordinating THIS chat's own background agents crosses no boundary.
  "SendMessage",
  "TeamList",
]);

/** Sandbox-scoped tools make no sense in Code (it has the real filesystem). */
export const SANDBOX_ONLY_NAMES = new Set([
  "RunPython",
  "RunCommand",
  "SandboxImage",
]);

/**
 * The space rule, for a tool that is not gated on a setting.
 *
 * Home advertises a fixed list; Code gets everything except the sandbox tools,
 * which make no sense where the real filesystem is.
 */
export function spaceAllows(name: string, space: string | undefined): boolean {
  if (space === "home") return HOME_TOOL_NAMES.has(name);
  return !SANDBOX_ONLY_NAMES.has(name);
}
