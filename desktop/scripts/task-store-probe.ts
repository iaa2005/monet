/**
 * The Background tasks registry.
 *
 * The panel used to list running SESSIONS, so a chat forty commands deep read
 * as one line. This registry is per tool RUN, titled by the model's own
 * `description` when it wrote one — that is the whole point: "Register probe,
 * build and smoke" is worth reading, the command it expands to is not.
 *
 * The checks that matter here are the ones about rows that never close. A tool
 * call whose result never arrives — the user pressed Stop, the run errored
 * between the call and the result — must not sit spinning forever, and must not
 * be relabelled as a success it never achieved.
 */

import {
  MAX_TASKS,
  mergeTasks,
  taskDetail,
  taskTitle,
  toolLabel,
  useTaskStore,
} from "../src/renderer/stores/taskStore";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const store = (): ReturnType<typeof useTaskStore.getState> =>
  useTaskStore.getState();
const reset = (): void => useTaskStore.setState({ tasks: [] });

// ── 1. Titles: the model's own name wins ──────────────────────────────
{
  check(
    "a model-written description becomes the title",
    taskTitle("Bash", {
      command: "npm pkg set scripts.smoke:reload=... && npm run build",
      description: "Register probe, build and smoke",
    }) === "Register probe, build and smoke",
  );
  check(
    "without one, the tool and its argument stand in",
    taskTitle("Read", { file_path: "D:\\p\\src\\main\\agent\\index.ts" }) ===
      "Read · index.ts",
    taskTitle("Read", { file_path: "D:\\p\\src\\main\\agent\\index.ts" }),
  );
  check(
    "a bare tool with no argument still gets a name",
    taskTitle("TodoWrite", {}) === "Plan",
    taskTitle("TodoWrite", {}),
  );
  const long = taskTitle("Bash", { command: "x".repeat(300) });
  check("a giant command is truncated", long.length <= 70, `${long.length} chars`);
  check(
    "a multi-line description is flattened to one line",
    !taskTitle("Bash", { command: "c", description: "line one\nline two" }).includes("\n"),
  );
  check(
    "an empty description does not win over the argument",
    taskTitle("Bash", { command: "ls", description: "   " }) === "Bash · ls",
    taskTitle("Bash", { command: "ls", description: "   " }),
  );
}

// ── 2. Detail: the command in full, paths shortened ───────────────────
{
  check(
    "a command is kept whole — it is the thing worth reading",
    taskDetail("Bash", { command: "git log --oneline -5" }) === "git log --oneline -5",
  );
  check(
    "a path is reduced to its basename",
    taskDetail("Edit", { file_path: "/a/b/c/chatStore.ts" }) === "chatStore.ts",
  );
  check("nothing to show is undefined, not empty", taskDetail("TodoWrite", {}) === undefined);
  // The sandbox file tools call their path `name`, not `file_path`. Missing it
  // is what turned the panel into a wall of bare "SandboxWrite" rows.
  check(
    "the sandbox tools' `name` is a path too",
    taskDetail("SandboxWrite", { name: "src/app.py", content: "x" }) === "app.py",
    taskDetail("SandboxWrite", { name: "src/app.py", content: "x" }),
  );
}

// ── 2b. Sandbox writes must say which file ────────────────────────────
{
  check(
    "a sandbox write names the file",
    taskTitle("SandboxWrite", { name: "src/app.py", content: "print(1)" }) ===
      "Sandbox write · app.py",
    taskTitle("SandboxWrite", { name: "src/app.py", content: "print(1)" }),
  );
  check(
    "…and so do read and edit",
    toolLabel("SandboxRead") === "Sandbox read" && toolLabel("SandboxEdit") === "Sandbox edit",
    `${toolLabel("SandboxRead")} / ${toolLabel("SandboxEdit")}`,
  );
  check(
    "listing the sandbox reads as files, not a raw tool name",
    toolLabel("SandboxList") === "Sandbox files",
    toolLabel("SandboxList"),
  );
}

// ── 3. MCP tools must be readable ─────────────────────────────────────
{
  check(
    "mcp__server__tool is split into something legible",
    toolLabel("mcp__dropbox__list_folder") === "dropbox · list_folder",
    toolLabel("mcp__dropbox__list_folder"),
  );
  check("an ordinary tool is left alone", toolLabel("WebFetch") === "WebFetch");
}

// ── 4. The lifecycle ──────────────────────────────────────────────────
{
  reset();
  store().startTask("s1", "t1", "Bash", { command: "ls", description: "List files" });
  check("a call opens a running row", store().tasks[0]?.status === "running");
  check("titled by the model", store().tasks[0]?.title === "List files");

  store().finishTask("t1", "a.txt\nb.txt");
  check("its result closes the row", store().tasks[0]?.status === "done");
  check("and the output is kept", store().tasks[0]?.output?.includes("a.txt"));
  check("with an end time, so duration can be shown", !!store().tasks[0]?.finishedAt);

  // A duplicated event must not open a second row for the same call.
  store().startTask("s1", "t1", "Bash", { command: "ls" });
  check("a repeated call event is ignored", store().tasks.length === 1, store().tasks.length);

  // Nor may a late second result reopen or overwrite a finished one.
  store().finishTask("t1", "different");
  check("a late duplicate result changes nothing", store().tasks[0]?.output === "a.txt\nb.txt");
}

// ── 5. Newest first ───────────────────────────────────────────────────
{
  reset();
  store().startTask("s1", "a", "Bash", { description: "first" });
  store().startTask("s1", "b", "Bash", { description: "second" });
  check("the most recent is on top", store().tasks[0]?.title === "second");
}

// ── 6. Rows that never close ──────────────────────────────────────────
{
  reset();
  store().startTask("s1", "t1", "Bash", { description: "interrupted" });
  store().startTask("s2", "t2", "Bash", { description: "other chat" });
  store().settleSession("s1");
  const t1 = store().tasks.find((t) => t.id === "t1");
  const t2 = store().tasks.find((t) => t.id === "t2");
  // Spinning forever is the obvious bug; "done" is the subtle one — it claims
  // a result that never came back.
  check("a stopped run does not leave a row spinning", t1?.status !== "running", t1?.status);
  check("and does not claim it succeeded", t1?.status === "error", t1?.status);
  check("another chat's run is untouched", t2?.status === "running", t2?.status);
}

// ── 7. Clear keeps live work ──────────────────────────────────────────
{
  reset();
  store().startTask("s1", "done1", "Bash", { description: "finished" });
  store().finishTask("done1", "ok");
  store().startTask("s1", "live1", "Bash", { description: "still going" });
  store().clear();
  check("Clear removes the finished rows", !store().tasks.some((t) => t.id === "done1"));
  // Clearing a running row would strand it: its result arrives later with
  // nothing to attach to, and the work vanishes from view mid-flight.
  check("but never a running one", store().tasks.some((t) => t.id === "live1"));
}

// ── 8. The cap ────────────────────────────────────────────────────────
{
  reset();
  for (let i = 0; i < MAX_TASKS + 50; i++) {
    store().startTask("s1", `t${i}`, "Bash", { description: `run ${i}` });
    store().finishTask(`t${i}`, "ok");
  }
  check("the list is capped", store().tasks.length === MAX_TASKS, store().tasks.length);
  check(
    "and keeps the newest, not the oldest",
    store().tasks[0]?.title === `run ${MAX_TASKS + 49}`,
    store().tasks[0]?.title,
  );
}
{
  // A running row must survive the trim — dropping it strands it as
  // permanently unfinished in the UI.
  reset();
  store().startTask("s1", "old-live", "Bash", { description: "long build" });
  for (let i = 0; i < MAX_TASKS + 20; i++) {
    store().startTask("s1", `f${i}`, "Bash", { description: `run ${i}` });
    store().finishTask(`f${i}`, "ok");
  }
  check(
    "an old running row is not trimmed away",
    store().tasks.some((t) => t.id === "old-live"),
    store().tasks.length,
  );
  store().finishTask("old-live", "built");
  check("and can still be closed by its result",
    store().tasks.find((t) => t.id === "old-live")?.status === "done");
}

// -- 9. Hydrating from the durable log --------------------------------
{
  // History now outlives the window: the log is written in the main process,
  // so a reload reads back what already ran. The merge has to survive a live
  // run in progress — a row the DB still holds as "running" must not overwrite
  // the same row this window has already seen finish.
  const stored = [
    { id: "old", sessionId: "s0", tool: "Bash", title: "yesterday", status: "done" as const, startedAt: 100 },
    { id: "live", sessionId: "s1", tool: "Bash", title: "stale copy", status: "running" as const, startedAt: 200 },
  ];
  const live = [
    { id: "live", sessionId: "s1", tool: "Bash", title: "fresh copy", status: "done" as const, startedAt: 200, output: "done!" },
  ];
  const merged = mergeTasks(live, stored);

  check("history from before the restart appears", merged.some((t) => t.id === "old"));
  check("a row is not duplicated by hydration", merged.filter((t) => t.id === "live").length === 1);
  check(
    "and the live copy wins over the stored one",
    merged.find((t) => t.id === "live")?.status === "done",
    merged.find((t) => t.id === "live")?.status,
  );
  check(
    "the merged list is newest-first",
    merged.map((t) => t.startedAt).every((v, i, a) => i === 0 || a[i - 1]! >= v),
    JSON.stringify(merged.map((t) => t.startedAt)),
  );
  check("nothing stored, nothing changes", mergeTasks(live, []).length === 1);
  check("nothing live, everything stored shows", mergeTasks([], stored).length === 2);
}

// ── A row closes on the RESULT, not on the placeholder ──────────────────
//
// A tool emits `tool_result` three times: a placeholder before it runs,
// progress while it runs, and the actual result. The panel closed on the
// first, so every task read "Completed · 0s" with the word "Running…" as its
// output — and then ignored the real result, because finishTask only touches a
// row that is still running. It looked like a browser bug, a sleep bug and a
// bash bug in turn; it was one line in the event handler.
//
// The store cannot see the flag itself, so what is pinned here is the rule it
// depends on: a row that has been closed stays closed, and a row closed with
// the real output keeps it.
{
  reset();
  store().startTask("s1", "t1", "BrowserNavigate", { url: "http://localhost:5173" });
  check("a fresh row is running", store().tasks[0]?.status === "running");

  // What the placeholder USED to do.
  store().finishTask("t1", "Running...", false);
  check(
    "once closed, a row keeps the output it was closed with",
    store().tasks[0]?.output === "Running...",
  );

  // The real result, arriving second — silently dropped, which is what made
  // the bug invisible rather than merely wrong.
  store().finishTask("t1", 'Opened "Портфолио" — http://localhost:5173/', false);
  check(
    "a second close cannot correct the first",
    store().tasks[0]?.output === "Running...",
    store().tasks[0]?.output,
  );

  // So the row must still be running when the result lands.
  reset();
  store().startTask("s1", "t2", "BrowserNavigate", { url: "http://localhost:5173" });
  store().finishTask("t2", 'Opened "Портфолио" — http://localhost:5173/', false);
  check(
    "closed by the result, the row shows the result",
    store().tasks[0]?.output?.startsWith("Opened"),
    store().tasks[0]?.output,
  );
  check("and is done", store().tasks[0]?.status === "done");
  reset();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL TASK-STORE CHECKS PASSED");
process.exit(failures ? 1 : 0);
