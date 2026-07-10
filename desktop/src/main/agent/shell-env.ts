/**
 * POSIX shell discovery for the vendor Bash tool.
 *
 * On Windows the vendor BashTool refuses to run without a POSIX shell
 * ("No suitable shell found… ensure the SHELL environment variable is set"),
 * and a desktop app launched from the GUI has no SHELL. Probe the usual
 * Git-for-Windows locations once and export SHELL/CLAUDE_CODE_GIT_BASH_PATH;
 * when nothing is found the Bash tool is dropped from the toolset entirely so
 * the model goes straight to PowerShell instead of failing first.
 */

import { existsSync } from "fs";
import { join } from "path";

let resolved: string | null | undefined;

export function ensurePosixShell(): string | null {
  if (resolved !== undefined) return resolved;

  if (process.platform !== "win32") {
    resolved = process.env.SHELL ?? "/bin/bash";
    return resolved;
  }

  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    process.env.SHELL,
    join(pf, "Git", "bin", "bash.exe"),
    join(pf, "Git", "usr", "bin", "bash.exe"),
    join(pf86, "Git", "bin", "bash.exe"),
    local ? join(local, "Programs", "Git", "bin", "bash.exe") : undefined,
  ].filter((c): c is string => !!c);

  for (const c of candidates) {
    try {
      if (existsSync(c)) {
        process.env.SHELL = c;
        process.env.CLAUDE_CODE_GIT_BASH_PATH = c;
        resolved = c;
        console.log(`[shell] POSIX shell for Bash tool: ${c}`);
        return c;
      }
    } catch {
      /* keep probing */
    }
  }

  console.warn(
    "[shell] no POSIX shell found — Bash tool disabled, PowerShell only",
  );
  resolved = null;
  return null;
}
