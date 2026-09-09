/**
 * Which shell the model is offered.
 *
 * The cases that matter cannot be reproduced on the machine running this: a
 * Windows box with no Git Bash, a Mac where PowerShell would fail on every
 * call, a user who asked for a shell their machine does not have. Getting one
 * of them wrong is silent in the worst way — the model is handed a tool that
 * errors on every call, or handed none at all and told to run a command.
 *
 *   npm run smoke:shell
 */

import { shellAllowed, type ShellChoice } from "../src/main/agent/shell-choice";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) failures++;
};

const on = (
  platform: string,
  hasPosixShell: boolean,
  choice: ShellChoice = "auto",
): string[] =>
  (["Bash", "PowerShell"] as const).filter((t) =>
    shellAllowed(t, { platform, hasPosixShell, choice }),
  );

const same = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// ── The machine's own facts, which beat any setting ─────────────────────

// PowerShell off Windows errors on every call; its own isEnabled() does not
// check the platform, so this is the only thing standing in the way.
check("mac gets Bash alone", same(on("darwin", true), ["Bash"]));
check("linux gets Bash alone", same(on("linux", true), ["Bash"]));
check(
  "and PowerShell is refused there even when asked for by name",
  same(on("darwin", true, "powershell"), ["Bash"]),
  on("darwin", true, "powershell"),
);
// Bash without a POSIX shell errors on every call too.
check(
  "windows with no Git Bash gets PowerShell",
  same(on("win32", false), ["PowerShell"]),
  on("win32", false),
);
// A setting carried over from a machine that HAD Git Bash must not leave
// this one with no shell at all. The probe found this: it did.
check(
  "even when Bash was asked for by name",
  same(on("win32", false, "bash"), ["PowerShell"]),
  on("win32", false, "bash"),
);
// The pathological box: no POSIX shell and not Windows. Nothing can be
// offered, and offering something that fails on every call would be worse.
check("a machine with neither is given neither", same(on("linux", false), []));

// ── The choice, on the one platform that has one ────────────────────────

// This is the saving: one shell, not two. It is also the change most likely
// to be noticed, which is why the default is the shell every piece of
// guidance the model carries is written in.
check(
  "windows defaults to Bash when it has one",
  same(on("win32", true), ["Bash"]),
  on("win32", true),
);
check(
  "PowerShell only, when asked",
  same(on("win32", true, "powershell"), ["PowerShell"]),
);
check("Bash only, when asked", same(on("win32", true, "bash"), ["Bash"]));
check(
  "and both remain available to anyone who wants them",
  same(on("win32", true, "both"), ["Bash", "PowerShell"]),
);

// ── Never nothing on a machine that can run something ───────────────────
//
// The failure this guards is a model told to run a command with no shell in
// its toolset. Every combination of platform and installation must leave at
// least one, whatever the setting says.
for (const platform of ["win32", "darwin", "linux"]) {
  for (const hasPosixShell of [true, false]) {
    for (const choice of ["auto", "bash", "powershell", "both"] as ShellChoice[]) {
      const got = on(platform, hasPosixShell, choice);
      const possible =
        (hasPosixShell ? 1 : 0) + (platform === "win32" ? 1 : 0) > 0;
      if (!possible) continue;
      check(
        `${platform} posix=${hasPosixShell} choice=${choice} leaves a shell`,
        got.length > 0,
        got,
      );
    }
  }
}

console.log(failures ? `\n${failures} FAILED` : "\nALL SHELL-CHOICE CHECKS PASSED");
process.exit(failures ? 1 : 0);
