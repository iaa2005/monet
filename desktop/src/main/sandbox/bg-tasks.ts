/**
 * Background commands in the sandbox — start now, be told later.
 *
 * A pip install or a build can take minutes, and RunCommand holds the whole
 * turn hostage while it does: the agent sits inside one tool call, unable to
 * think, narrate or start anything else. These run detached instead.
 *
 * The output goes to a FILE in the chat's own folder, not into container logs
 * reachable only through a dedicated tool. That choice removes a tool: interim
 * output is read with the same Read the model already uses for everything
 * else, and the completion arrives on its own. Reading the file is always a
 * complete answer, because the watcher appends the exit line to it — so even
 * if the report is missed, the file says what happened.
 *
 * Containers are named (no --rm) so the exit code survives until collected;
 * collection removes them, and everything left is removed when the app quits.
 * The same persistent pip target as every other sandbox container, so
 * `pip install` here is visible to RunCommand and ServeSandbox alike.
 */

import { appendFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import {
  activeImageTag,
  ensureSandboxImage,
  podmanRaw,
  sandboxWorkDir,
  PIP_ENV_ARGS,
  PIP_VOLUME_ARGS,
} from "./podman-engine.js";

/** Where a task's output lands, relative to the chat's sandbox root. Dotted so
 *  it stays out of the artifacts the chat shows the user — a build log is not
 *  something they asked for. */
export const TASK_OUTPUT_DIR = ".tasks";

export function taskOutputPath(taskId: string): string {
  return `${TASK_OUTPUT_DIR}/${taskId}.output`;
}

interface BgTask {
  id: string;
  sessionId: string;
  command: string;
  container: string;
  startedAt: number;
}

const tasks = new Map<string, BgTask>();
let seq = 0;

/** At most this many live background containers per session. */
const MAX_PER_SESSION = 4;

export async function startBgCommand(
  sessionId: string,
  command: string,
): Promise<{ ok: boolean; taskId?: string; outputPath?: string; error?: string }> {
  const mine = [...tasks.values()].filter((t) => t.sessionId === sessionId);
  if (mine.length >= MAX_PER_SESSION) {
    return {
      ok: false,
      error:
        `Already ${MAX_PER_SESSION} background tasks running in this chat. ` +
        `Wait for one to report back before starting another.`,
    };
  }
  // A detached run starts its own container, so it cannot rely on a foreground
  // call having built the image first — the very first thing a chat does may be
  // a background install. This also settles which tag to use.
  const image = await ensureSandboxImage();
  if (!image.ok) return { ok: false, error: image.error ?? "The sandbox image is not ready." };
  const id = `bg-${++seq}-${Date.now().toString(36)}`;
  const container = `monet-bg-${id}`;
  const dir = sandboxWorkDir(sessionId);
  const rel = taskOutputPath(id);
  // The directory is made on the HOST side: the container's own mkdir would
  // race the first write, and a missing directory would fail the redirect
  // before the command ever ran.
  await mkdir(join(dir, TASK_OUTPUT_DIR), { recursive: true });
  const r = await podmanRaw(
    [
      "run",
      "-d",
      "--name",
      container,
      "-v",
      `${dir}:/work`,
      ...PIP_VOLUME_ARGS,
      ...PIP_ENV_ARGS,
      "-w",
      "/work",
      activeImageTag(),
      "sh",
      "-lc",
      // Both streams to the file, unbuffered enough to be readable while it
      // runs — a log nobody can read until the end is not interim output.
      `exec >"/work/${rel}" 2>&1; ${command}`,
    ],
    { timeoutMs: 60_000 },
  );
  if (r.code !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || "podman run failed").slice(0, 400) };
  }
  tasks.set(id, { id, sessionId, command, container, startedAt: Date.now() });
  watchForExit(id);
  return { ok: true, taskId: id, outputPath: rel };
}

/** Last lines of a task's output file, for the completion report. */
async function tailOutput(
  sessionId: string,
  taskId: string,
  lines: number,
): Promise<string> {
  try {
    const text = await readFile(
      join(sandboxWorkDir(sessionId), taskOutputPath(taskId)),
      "utf8",
    );
    return text.split(/\r?\n/).slice(-lines).join("\n").trim();
  } catch {
    return "";
  }
}

/** How often the watcher asks whether a task has finished. */
const WATCH_EVERY_MS = 5_000;
/** After this the watcher gives up watching. The output file is untouched and
 * still readable — a day-long job is just not something to poll. */
const WATCH_FOR_MS = 2 * 60 * 60_000;

/**
 * Tell the chat when the task finishes, instead of waiting to be asked.
 *
 * Before this, the only way to learn a background command had finished was to
 * call a tool and ask — so the model did what anyone would and polled: Sleep
 * 20, check, Sleep 30, check. Measured in a real run, that pattern cost four
 * turns to observe one 66-second install, and each of those turns is a whole
 * model call spent on waiting. Sleep and the check tool are both gone now;
 * this is what replaced them.
 *
 * The report goes into the same queue background sub-agents use, so it is
 * delivered at a turn boundary — and an idle chat picks it up on its own
 * (see deliverBackgroundResults).
 */
function watchForExit(taskId: string): void {
  const deadline = Date.now() + WATCH_FOR_MS;
  const timer = setInterval(() => {
    void (async () => {
      const t = tasks.get(taskId);
      // Collected by BackgroundOutput already, or gone — nothing to report.
      if (!t) {
        clearInterval(timer);
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        return;
      }
      const inspect = await podmanRaw(
        ["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", t.container],
        { timeoutMs: 30_000 },
      );
      if (inspect.code !== 0) {
        clearInterval(timer);
        tasks.delete(taskId);
        return;
      }
      const [runningWord, codeWord] = inspect.stdout.trim().split(/\s+/);
      if (runningWord === "true") return;

      clearInterval(timer);
      const seconds = Math.round((Date.now() - t.startedAt) / 1000);
      const code = Number(codeWord);
      const verdict =
        code === 0
          ? `exited 0 after ${seconds}s`
          : `exited ${code} after ${seconds}s`;
      // Stamp the verdict into the file BEFORE reporting, so reading the file
      // is always a complete answer — including when the report is never seen.
      await appendFile(
        join(sandboxWorkDir(t.sessionId), taskOutputPath(taskId)),
        `\n--- ${verdict} ---\n`,
        "utf8",
      ).catch(() => undefined);
      const tail = await tailOutput(t.sessionId, taskId, 60);
      await podmanRaw(["rm", "-f", t.container], { timeoutMs: 30_000 }).catch(
        () => null,
      );
      tasks.delete(taskId);

      const { pushBgResult } = await import("../agent/bg-agents.js");
      pushBgResult(
        t.sessionId,
        "background-command",
        t.command.slice(0, 120),
        [
          `${t.command}`,
          "",
          code === 0
            ? `Finished successfully after ${seconds}s.`
            : `Exited with code ${code} after ${seconds}s.`,
          `Full output: ${taskOutputPath(taskId)}`,
          tail ? `\n--- output (last lines) ---\n${tail}` : "(no output)",
        ].join("\n"),
        taskId,
      );
    })();
  }, WATCH_EVERY_MS);
  // Never hold the app open for a watcher.
  timer.unref?.();
}

// A bgStatus() used to live here, behind a BackgroundOutput tool: ask whether
// a task is running, get its tail, collect it if it had finished. Both are
// gone. Everything it answered is now answerable without a tool call — the
// output file carries the interim text and, once the watcher has been round,
// the exit line too.

/** App shutdown: no background container may outlive the app. */
export async function killAllBgTasks(): Promise<void> {
  for (const t of tasks.values()) {
    await podmanRaw(["rm", "-f", t.container], { timeoutMs: 15_000 }).catch(() => null);
  }
  tasks.clear();
}
