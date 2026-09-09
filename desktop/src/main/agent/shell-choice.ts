/**
 * Which shell the model is offered on Windows.
 *
 * Two were, always: Bash (Git Bash, when one is installed) and PowerShell.
 * They do the same job, and between them they cost 4,551 tokens of
 * description and schema on every single turn — the two largest items in the
 * toolset by a wide margin, ahead of the next by a factor of three. A model
 * that has both spends part of every turn deciding which to use, and the
 * decision has no right answer: whichever it picks, the command runs.
 *
 * So one, by default, and the other by choice. Not a silent choice either —
 * the shells are not interchangeable in the details (path separators,
 * quoting, `2>/dev/null` against `2>$null`), and a user who writes PowerShell
 * all day should be able to say so.
 *
 * `both` stays available and honest about its cost. Nothing here applies off
 * Windows, where there is only ever one.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";

export type ShellChoice = "auto" | "bash" | "powershell" | "both";

export interface ShellConfig {
  choice: ShellChoice;
}

/**
 * Bash where there is one, PowerShell where there is not.
 *
 * Not a toss-up. Every piece of guidance the model carries — the vendor
 * prompt's own examples, this app's working-discipline block, the git and
 * gh recipes, most skills anyone writes — is POSIX, and a model asked to
 * translate all of it on the fly does it worse than it runs it. PowerShell
 * is what Windows always has, so it is what remains when Git Bash is not
 * installed.
 */
const DEFAULT: ShellConfig = { choice: "auto" };

function configPath(): string {
  return join(getDataDir(), "shell.json");
}

function clean(v: unknown): ShellChoice {
  return v === "bash" || v === "powershell" || v === "both" || v === "auto"
    ? v
    : DEFAULT.choice;
}

export function getShellConfig(): ShellConfig {
  try {
    const p = configPath();
    if (!existsSync(p)) return { ...DEFAULT };
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<ShellConfig>;
    return { choice: clean(raw.choice) };
  } catch {
    return { ...DEFAULT };
  }
}

export function setShellConfig(patch: Partial<ShellConfig>): ShellConfig {
  const next: ShellConfig = { choice: clean(patch.choice ?? getShellConfig().choice) };
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf-8");
  } catch {
    /* a read-only data folder is not worth failing the toolset over */
  }
  return next;
}

/**
 * Whether a shell tool may be advertised, given what is installed.
 *
 * Pure, and takes the world as arguments, because the interesting cases are
 * the ones that cannot be reproduced on the machine running the tests: a
 * Windows box with no Git Bash, a Mac where PowerShell would fail on every
 * call, a user who asked for PowerShell on a machine that has both.
 */
export function shellAllowed(
  tool: "Bash" | "PowerShell",
  world: { platform: string; hasPosixShell: boolean; choice: ShellChoice },
): boolean {
  const { platform, hasPosixShell, choice } = world;
  // Facts about the box, and they beat the setting: Bash without a POSIX
  // shell errors on every call, and PowerShell off Windows does the same
  // (its own isEnabled() does not check the platform).
  const canBash = hasPosixShell;
  const canPowerShell = platform === "win32";
  if (tool === "Bash" && !canBash) return false;
  if (tool === "PowerShell" && !canPowerShell) return false;
  // Off Windows there is one candidate left, so there is nothing to choose.
  if (platform !== "win32") return true;
  if (choice === "both") return true;

  const wanted =
    choice === "powershell"
      ? "PowerShell"
      : choice === "bash"
        ? "Bash"
        : // auto: the shell every piece of guidance the model carries is
          // written in, where the machine has one.
          canBash
          ? "Bash"
          : "PowerShell";
  // A preference for a shell this machine does not have is not a preference,
  // it is a setting left over from another machine — and honouring it would
  // hand the model no shell at all on a box that has one. The probe caught
  // exactly that: Windows, no Git Bash, "Bash only" → nothing.
  const wantedIsReal = wanted === "Bash" ? canBash : canPowerShell;
  return wantedIsReal ? tool === wanted : true;
}
