/**
 * Running a project's own checks and reading the verdict.
 *
 * Checks run sequentially and stop at the FIRST failure: one red check is
 * already a complete fix prompt, the model fixes one thing at a time anyway,
 * and every check after a failing typecheck would mostly fail for the same
 * reason. The re-run after each fix attempt is what eventually proves the
 * whole set green.
 *
 * No electron imports here — the probe runs this under plain node.
 */

import { spawn, spawnSync } from "child_process";
import type { VerifyCheck } from "./detect.js";

/** What the model gets to read. The tail: the summary and the last errors
 * live there, and a 40K typecheck dump would drown the turn. */
const OUTPUT_TAIL = 6_000;

export interface CheckResult {
  check: VerifyCheck;
  ok: boolean;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  /** The user pressed stop mid-check — not a verdict at all. */
  aborted: boolean;
}

function tail(s: string): string {
  const t = s.trim();
  return t.length > OUTPUT_TAIL ? `…${t.slice(-OUTPUT_TAIL)}` : t;
}

export function runCheck(
  cwd: string,
  check: VerifyCheck,
  isAborted: () => boolean,
): Promise<CheckResult> {
  return new Promise((resolve) => {
    const child = spawn(check.command, {
      cwd,
      shell: true,
      windowsHide: true,
      // CI conventions turn off spinners, prompts and colour codes — the
      // output is for a model, not a terminal.
      env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    });

    let out = "";
    const cap = (chunk: unknown): void => {
      out += String(chunk);
      // Keep memory bounded on a chatty build; the tail is all we report.
      if (out.length > 60_000) out = out.slice(-30_000);
    };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);

    let timedOut = false;
    let aborted = false;
    let settled = false;

    // shell:true on Windows runs via cmd.exe — child.kill() would orphan the
    // real process tree, so take the tree down explicitly.
    const kill = (): void => {
      try {
        if (process.platform === "win32" && child.pid)
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
          });
        else child.kill("SIGKILL");
      } catch {
        /* best effort */
      }
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      kill();
    }, check.timeoutMs);
    const abortPoll = setInterval(() => {
      if (isAborted()) {
        aborted = true;
        kill();
      }
    }, 500);

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearInterval(abortPoll);
      resolve({
        check,
        ok: code === 0 && !timedOut && !aborted,
        output: tail(out),
        exitCode: code,
        timedOut,
        aborted,
      });
    };

    child.on("error", (e) => {
      cap(String(e));
      finish(-1);
    });
    child.on("close", (code) => finish(code));
  });
}

export interface ChecksVerdict {
  /** The first failing check, or null when everything ran green. */
  failure: CheckResult | null;
  ran: number;
  aborted: boolean;
}

export async function runChecks(
  cwd: string,
  checks: VerifyCheck[],
  isAborted: () => boolean,
): Promise<ChecksVerdict> {
  let ran = 0;
  for (const check of checks) {
    if (isAborted()) return { failure: null, ran, aborted: true };
    const result = await runCheck(cwd, check, isAborted);
    if (result.aborted) return { failure: null, ran, aborted: true };
    ran++;
    if (!result.ok) return { failure: result, ran, aborted: false };
  }
  return { failure: null, ran, aborted: false };
}
