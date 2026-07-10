/**
 * Commands IPC — the slash-command catalog for the composer's "/" menu.
 *
 * Sources the vendor (leaked CC) command registry: prompt-type commands are
 * the ones that expand cleanly into a prompt (CLI-UI commands like /login are
 * local-jsx and don't apply to the desktop). Skills (user/project/bundled)
 * are the getSkillToolCommands subset — the menu shows them as their own
 * section.
 */

import { ipcMain } from "electron";
import { getCommands, getSkillToolCommands } from "@vendor/commands.js";
import { getProjectRoot } from "@vendor/bootstrap/state.js";
import type { Command } from "@vendor/types/command.js";
import { initVendorRuntime } from "../agent/vendor-context.js";

export interface SlashCommandInfo {
  name: string;
  description: string;
}

function describe(c: Command): string {
  const raw =
    ("whenToUse" in c && c.whenToUse) ||
    ("description" in c && c.description) ||
    "";
  return typeof raw === "string" ? raw : "";
}

function hidden(c: Command): boolean {
  return !!(c as { isHidden?: boolean }).isHidden;
}

export function registerCommandsIPC(): void {
  ipcMain.handle(
    "commands:list",
    async (): Promise<{
      commands: SlashCommandInfo[];
      skills: SlashCommandInfo[];
    }> => {
      try {
        initVendorRuntime();
        const root = getProjectRoot();
        const [all, skillCmds] = await Promise.all([
          getCommands(root),
          getSkillToolCommands(root).catch(() => [] as Command[]),
        ]);
        const skillNames = new Set(skillCmds.map((s) => s.name));
        const prompts = all.filter((c) => c.type === "prompt" && !hidden(c));
        const toInfo = (c: Command): SlashCommandInfo => ({
          name: c.name,
          description: describe(c),
        });
        return {
          commands: prompts.filter((c) => !skillNames.has(c.name)).map(toInfo),
          skills: prompts.filter((c) => skillNames.has(c.name)).map(toInfo),
        };
      } catch (err) {
        console.warn(
          "[commands] list failed:",
          err instanceof Error ? err.message : err,
        );
        return { commands: [], skills: [] };
      }
    },
  );
}
