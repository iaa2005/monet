/**
 * What Home is allowed to do.
 *
 * Home is the isolated space: no host filesystem, no shell, files scoped to the
 * chat's own sandbox. The list of tools it advertises is exactly the sort that
 * drifts — a tool gets added somewhere else and nobody asks which space it
 * belongs to — and there was no check on it at all.
 *
 * Asked as a question about boundaries rather than a list, so the answers say
 * why: what may touch the machine, what may touch the user's own setup, and what
 * may not.
 */

import { spaceAllows } from "../src/main/agent/space-tools";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const inHome = (name: string): boolean => spaceAllows(name, "home");
const inCode = (name: string): boolean => spaceAllows(name, "code");

// ── 1. The machine stays out ──────────────────────────────────────────
{
  for (const name of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit"])
    check(`Home refuses ${name}`, !inHome(name));
  check("but Code has Bash", inCode("Bash"));
  check("and Read", inCode("Read"));
}

// ── 2. The sandbox is how Home touches files ──────────────────────────
{
  for (const name of ["RunPython", "RunCommand", "SandboxList", "SandboxRead", "SandboxWrite", "SandboxEdit"])
    check(`Home allows ${name}`, inHome(name));
  // And they make no sense in Code, which has the real filesystem.
  check("Code refuses SandboxRead", !inCode("SandboxRead"));
}

// ── 3. The user's own setup is not the machine ────────────────────────
{
  // Remember writes to the host too, and has always been in Home: a memory is
  // about the USER, not about the workspace. A skill is the same class of thing,
  // written under a validated slug in the app's own folder.
  check("Home allows Remember", inHome("Remember"));
  check("Home allows Skill — running one", inHome("Skill"));
  check("Home allows CreateSkill — writing one", inHome("CreateSkill"));
  check("and Code has it too", inCode("CreateSkill"));
}

// ── 4. Asking, waiting, reading the web ───────────────────────────────
{
  for (const name of ["AskUserQuestion", "TodoWrite", "Sleep", "SendMessage", "TeamList", "ReadMediaFile"])
    check(`Home allows ${name}`, inHome(name));
}

// ── 5. Where this module's answer stops ──────────────────────────────
{
  // LSP, ToolSearch and the MCP-resource tools are gated on settings and on
  // whether servers exist, in isSpaceToolAllowed — which needs main. The list
  // still has an opinion, and it is the conservative one: none of them is in
  // Home's set, so if the setting checks were ever removed the list would
  // refuse them rather than let them through.
  for (const name of ["LSP", "ListMcpResources", "ReadMcpResource", "Bash"])
    check(`the list alone would refuse ${name} in Home`, !inHome(name));
  // And it says nothing about Code beyond the sandbox tools, which is why the
  // config checks have to come first there.
  check("while Code's list allows LSP", inCode("LSP"));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL HOME-TOOLSET CHECKS PASSED");
process.exit(failures ? 1 : 0);
