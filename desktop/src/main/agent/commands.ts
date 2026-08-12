/**
 * The slash-command registry — ours now.
 *
 * The leaked CLI's commands.ts statically imports seventy-nine commands, each
 * dragging its terminal UI: `commands/` (211 files), `components/` (82),
 * `ink/`, `screens/`, `keybindings/`. We render none of it — the composer's
 * "/" menu keeps only `type: "prompt"` entries, and of the seventy-nine
 * exactly eight are prompts. Rollup was already shaking most of that back
 * out (dropping the import costs main only ~307 KiB), so this is not a
 * size fix: it is that 349 source files stopped being reachable at all, and
 * a tree we are absorbing has to be a tree we can carry.
 *
 * What actually matters here is the DYNAMIC half: skills from the skill dirs,
 * bundled skills, plugin commands and plugin skills, plus skills discovered
 * mid-session. That half we keep verbatim — it is the machinery behind the
 * Skill tool and the Skills section of the menu.
 *
 * The static half shrinks to the three prompt commands worth having (/init,
 * /commit, /review + /ultrareview). Dropped with it: /commit-push-pr and
 * /init-verifiers (Anthropic-internal), /insights and /statusline (already
 * filtered as inapplicable — see ipc/commands.ts), and every local-jsx command
 * whose whole body is a terminal dialog.
 */

import memoize from "lodash-es/memoize.js";
import {
  isCommandEnabled,
  getCommandName,
  type Command,
} from "../engine/types/command.js";
import {
  getSkillDirCommands,
  clearSkillCaches,
  getDynamicSkills,
} from "../skills/loader/loadSkillsDir.js";
import { getBundledSkills } from "../skills/loader/bundledSkills.js";
import { getBuiltinPluginSkillCommands } from "../plugins/builtin/builtinPlugins.js";
import {
  getPluginCommands,
  clearPluginCommandCache,
  getPluginSkills,
  clearPluginSkillsCache,
} from "../plugins/loadPluginCommands.js";
import commit from "@anthropic/cli/commands/commit.js";
import init from "@anthropic/cli/commands/init.js";
import review, { ultrareview } from "@anthropic/cli/commands/review.js";

export type {
  Command,
  CommandBase,
  PromptCommand,
  LocalJSXCommandContext,
  LocalCommandResult,
  CommandResultDisplay,
} from "../engine/types/command.js";
export { getCommandName, isCommandEnabled } from "../engine/types/command.js";

/** The built-ins we keep. Declared as a function: their `isEnabled` reads
 *  config, which is not readable at module init. */
const BUILTINS = (): Command[] => [init, commit, review, ultrareview];

const BUILTIN_NAMES = new Set(["init", "commit", "review", "ultrareview"]);

/**
 * Names that carry no context of their own. Session titling asks this before
 * using a `/command` message as a title: `/model sonnet` says nothing about
 * the conversation, `/review reticulate splines` does. The composer's own
 * local commands are not here — they are handled in the renderer and never
 * reach a transcript as a command message.
 */
export function builtInCommandNames(): ReadonlySet<string> {
  return BUILTIN_NAMES;
}

async function loadSkills(cwd: string): Promise<Command[]> {
  // Each source is allowed to fail alone — a broken plugin manifest must not
  // cost the user their skills, which is why the vendor wrapped every one of
  // these in its own catch. Kept.
  const [skillDirCommands, pluginSkills, pluginCommands] = await Promise.all([
    getSkillDirCommands(cwd).catch(() => [] as Command[]),
    getPluginSkills().catch(() => [] as Command[]),
    getPluginCommands().catch(() => [] as Command[]),
  ]);
  let bundled: Command[] = [];
  let builtinPlugin: Command[] = [];
  try {
    bundled = getBundledSkills();
  } catch {
    /* registered synchronously at startup; empty if startup skipped it */
  }
  try {
    builtinPlugin = getBuiltinPluginSkillCommands();
  } catch {
    /* no built-in plugins enabled */
  }
  return [
    ...bundled,
    ...builtinPlugin,
    ...skillDirCommands,
    ...pluginCommands,
    ...pluginSkills,
  ];
}

const loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => [
  ...(await loadSkills(cwd)),
  ...BUILTINS(),
]);

/**
 * Commands available right now. Loading is memoized per cwd (disk I/O and
 * dynamic imports); `isEnabled` is re-checked on every call so a config
 * change takes effect without a restart.
 */
export async function getCommands(cwd: string): Promise<Command[]> {
  const all = await loadAllCommands(cwd);
  const base = all.filter(isCommandEnabled);
  const dynamic = getDynamicSkills();
  if (dynamic.length === 0) return base;

  const known = new Set(base.map((c) => c.name));
  const extra = dynamic.filter((s) => !known.has(s.name) && isCommandEnabled(s));
  if (extra.length === 0) return base;

  // Skills discovered mid-session sit with the other skills, ahead of the
  // built-ins — the menu groups by section and reads top-down.
  const at = base.findIndex((c) => BUILTIN_NAMES.has(c.name));
  return at === -1
    ? [...base, ...extra]
    : [...base.slice(0, at), ...extra, ...base.slice(at)];
}

/**
 * What the Skill tool may invoke: prompt commands the model is allowed to
 * call, excluding the built-ins (those are the user's slash commands, not
 * capabilities) and anything without a description to choose it by.
 */
export const getSkillToolCommands = memoize(
  async (cwd: string): Promise<Command[]> => {
    const all = await getCommands(cwd);
    return all.filter(
      (cmd) =>
        cmd.type === "prompt" &&
        !cmd.disableModelInvocation &&
        cmd.source !== "builtin" &&
        (cmd.loadedFrom === "bundled" ||
          cmd.loadedFrom === "skills" ||
          cmd.loadedFrom === "commands_DEPRECATED" ||
          cmd.hasUserSpecifiedDescription ||
          cmd.whenToUse),
    );
  },
);

export function findCommand(
  name: string,
  commands: readonly Command[],
): Command | undefined {
  // getCommandName, not just `.name`: a plugin command's user-facing name is
  // namespaced, and that is what the user types.
  return commands.find(
    (c) =>
      c.name === name || getCommandName(c) === name || c.aliases?.includes(name),
  );
}

/**
 * Skills, as the SlashCommand tool sees them: capabilities rather than user
 * commands — from a skills dir, a plugin, or the bundle, and described well
 * enough for the model to pick one.
 */
export const getSlashCommandToolSkills = memoize(
  async (cwd: string): Promise<Command[]> => {
    try {
      const all = await getCommands(cwd);
      return all.filter(
        (cmd) =>
          cmd.type === "prompt" &&
          cmd.source !== "builtin" &&
          (cmd.hasUserSpecifiedDescription || cmd.whenToUse) &&
          (cmd.loadedFrom === "skills" ||
            cmd.loadedFrom === "plugin" ||
            cmd.loadedFrom === "bundled" ||
            cmd.disableModelInvocation),
      );
    } catch {
      // Skills are non-critical: a broken one must not take the turn with it.
      return [];
    }
  },
);

/**
 * Whether a slash command may run when its input arrived over the remote
 * bridge. Prompt commands expand to text and are safe by construction;
 * anything that renders a terminal dialog is not, and the built-ins we kept
 * are all prompts — so the vendor's hand-picked allowlist of local commands
 * has nothing left to allow.
 */
export function isBridgeSafeCommand(cmd: Command): boolean {
  return cmd.type === "prompt";
}

export function hasCommand(name: string, commands: readonly Command[]): boolean {
  return findCommand(name, commands) !== undefined;
}

export function getCommand(name: string, commands: readonly Command[]): Command {
  const command = findCommand(name, commands);
  if (!command)
    throw new ReferenceError(
      `Command ${name} not found. Available: ${commands
        .map((c) => getCommandName(c))
        .join(", ")}`,
    );
  return command;
}

/**
 * MCP-provided skills. They arrive over the MCP connection rather than from
 * disk, so they live in AppState instead of the registry and callers thread
 * them through separately.
 */
export function getMcpSkillCommands(
  mcpCommands: readonly Command[],
): readonly Command[] {
  return mcpCommands.filter(
    (cmd) =>
      cmd.type === "prompt" &&
      cmd.loadedFrom === "mcp" &&
      !cmd.disableModelInvocation,
  );
}

/** Forget everything cached about commands and skills — after the user edits
 *  a skill, installs a plugin, or changes the skills directory. */
export function clearCommandsCache(): void {
  loadAllCommands.cache?.clear?.();
  getSkillToolCommands.cache?.clear?.();
  clearPluginCommandCache();
  clearPluginSkillsCache();
  clearSkillCaches();
}
