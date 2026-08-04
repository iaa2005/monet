/**
 * Background commands in the sandbox — start now, collect later.
 *
 * A pip install or a build can take minutes, and RunCommand holds the whole
 * turn hostage while it does: the agent sits inside one tool call, unable to
 * think, narrate or start anything else. These run detached instead — the
 * same pattern the desktop's own developer uses (`run_in_background` + a
 * later output check): start a named container, keep working, poll its tail.
 *
 * Containers are named (no --rm) so the exit code survives until collected;
 * collection removes them, and everything left is removed when the app
 * quits. The same persistent pip target as every other sandbox container,
 * so `pip install` here is visible to RunCommand and ServeSandbox alike.
 */

import { podmanRaw, sandboxWorkDir, PIP_ENV_ARGS, IMAGE_TAG } from "./podman-engine.js";

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
): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  const mine = [...tasks.values()].filter((t) => t.sessionId === sessionId);
  if (mine.length >= MAX_PER_SESSION) {
    return {
      ok: false,
      error: `Already ${MAX_PER_SESSION} background tasks running — collect one with BackgroundOutput first.`,
    };
  }
  const id = `bg-${++seq}-${Date.now().toString(36)}`;
  const container = `monet-bg-${id}`;
  const dir = sandboxWorkDir(sessionId);
  const r = await podmanRaw(
    [
      "run",
      "-d",
      "--name",
      container,
      "-v",
      `${dir}:/work`,
      "-v",
      "monet-pip-cache:/root/.cache/pip",
      ...PIP_ENV_ARGS,
      "-w",
      "/work",
      IMAGE_TAG,
      "sh",
      "-lc",
      command,
    ],
    { timeoutMs: 60_000 },
  );
  if (r.code !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || "podman run failed").slice(0, 400) };
  }
  tasks.set(id, { id, sessionId, command, container, startedAt: Date.now() });
  return { ok: true, taskId: id };
}

export interface BgStatus {
  ok: boolean;
  running?: boolean;
  exitCode?: number | null;
  /** Last lines of combined output. */
  tail?: string;
  seconds?: number;
  error?: string;
}

/** Peek or collect: while running returns the tail; once exited, reports the
 * code, hands back the tail and removes the container. */
export async function bgStatus(taskId: string, tailLines = 60): Promise<BgStatus> {
  const t = tasks.get(taskId);
  if (!t) return { ok: false, error: `No background task ${taskId}.` };
  const inspect = await podmanRaw(
    ["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", t.container],
    { timeoutMs: 30_000 },
  );
  if (inspect.code !== 0) {
    tasks.delete(taskId);
    return { ok: false, error: "The task's container is gone." };
  }
  const [runningWord, codeWord] = inspect.stdout.trim().split(/\s+/);
  const running = runningWord === "true";
  const logs = await podmanRaw(["logs", "--tail", String(tailLines), t.container], {
    timeoutMs: 30_000,
  });
  const tail = [logs.stdout, logs.stderr].filter(Boolean).join("\n").trim();
  const seconds = Math.round((Date.now() - t.startedAt) / 1000);
  if (running) return { ok: true, running: true, tail, seconds };
  // Finished: collect and clean up.
  await podmanRaw(["rm", "-f", t.container], { timeoutMs: 30_000 }).catch(() => null);
  tasks.delete(taskId);
  return { ok: true, running: false, exitCode: Number(codeWord), tail, seconds };
}

/** App shutdown: no background container may outlive the app. */
export async function killAllBgTasks(): Promise<void> {
  for (const t of tasks.values()) {
    await podmanRaw(["rm", "-f", t.container], { timeoutMs: 15_000 }).catch(() => null);
  }
  tasks.clear();
}
