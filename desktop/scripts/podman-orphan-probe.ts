/**
 * The Podman orphan repair.
 *
 * The live bug: `machine list` was empty, no WSL distro existed, and yet
 * `machine init` kept failing with
 *
 *     Error: system connection "podman-machine-default" already exists.
 *     consider a different machine name or remove the connection with
 *     `podman system connection rm`
 *
 * The repair only unregistered orphaned WSL *distros*. With none left it fell
 * through an empty loop straight into `machine init`, hit the identical error,
 * and reported it — looking like it had tried something. Podman's system
 * connection registry is a separate file under AppData that `wsl --unregister`
 * and `machine rm` do not necessarily touch, so it has to be cleared on its own.
 *
 * Check 1 is the regression: it is driven with ZERO distros and one connection,
 * which is exactly the user's state, and fails on the old code.
 *
 * Order matters as much as the call itself — removing the connection after
 * `machine init` would leave init failing — so the checks assert the sequence,
 * not just that `rm` happened.
 */

import { orphanedMachineFailure, type OrphanRepairDeps } from "../src/main/sandbox/podman-engine";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** Records every command in order; init succeeds only once the connections it
 * would collide with are gone, exactly as podman behaves. */
function fakePodman(opts: { distros: string[]; connections: string[] }) {
  const calls: string[] = [];
  let distros = [...opts.distros];
  let connections = [...opts.connections];
  const deps: OrphanRepairDeps = {
    listDistros: async () => distros,
    unregister: async (d) => {
      calls.push(`unregister:${d}`);
      distros = distros.filter((x) => x !== d);
      return true;
    },
    listConnections: async () => connections,
    removeConnection: async (n) => {
      calls.push(`rm-connection:${n}`);
      connections = connections.filter((x) => x !== n);
      return true;
    },
    init: async () => {
      calls.push("init");
      if (connections.length)
        return {
          code: 125,
          stdout: "",
          stderr: `Error: system connection "${connections[0]}" already exists. consider a different machine name or remove the connection with \`podman system connection rm\``,
        };
      if (distros.length)
        return { code: 125, stdout: "", stderr: "Error: podman-machine-default: VM already exists" };
      return { code: 0, stdout: "Machine init complete", stderr: "" };
    },
  };
  return { deps, calls: () => calls };
}

const run = async (): Promise<void> => {
  // ── 1. The reported state: no distro, two stale connections ──────────
  {
    const f = fakePodman({
      distros: [],
      connections: ["podman-machine-default", "podman-machine-default-root"],
    });
    const r = await orphanedMachineFailure(true, f.deps);
    const calls = f.calls();
    check("repairs a machine blocked only by stale connections", r.ok, r.error);
    check(
      "removes BOTH connections",
      calls.filter((c) => c.startsWith("rm-connection:")).length === 2,
      JSON.stringify(calls),
    );
    check(
      "removes them before init",
      calls.indexOf("init") > calls.lastIndexOf("rm-connection:podman-machine-default-root"),
      JSON.stringify(calls),
    );
    check("needs only one init", calls.filter((c) => c === "init").length === 1);
    check("says what it did", r.log.includes("removing stale podman connection"), JSON.stringify(r.log));
  }

  // ── 2. The original state: orphaned distro, no connections ───────────
  {
    const f = fakePodman({ distros: ["podman-machine-default"], connections: [] });
    const r = await orphanedMachineFailure(true, f.deps);
    check("still repairs an orphaned WSL distro", r.ok, r.error);
    check(
      "unregisters it before init",
      f.calls().indexOf("unregister:podman-machine-default") < f.calls().indexOf("init"),
      JSON.stringify(f.calls()),
    );
  }

  // ── 3. Both at once ──────────────────────────────────────────────────
  {
    const f = fakePodman({
      distros: ["podman-machine-default"],
      connections: ["podman-machine-default"],
    });
    const r = await orphanedMachineFailure(true, f.deps);
    check("repairs both leftovers together", r.ok, r.error);
    check(
      "clears each exactly once",
      f.calls().join(",") ===
        "unregister:podman-machine-default,rm-connection:podman-machine-default,init",
      JSON.stringify(f.calls()),
    );
  }

  // ── 4. Without permission it must not touch anything ─────────────────
  {
    const f = fakePodman({ distros: [], connections: ["podman-machine-default"] });
    const r = await orphanedMachineFailure(false, f.deps);
    check("a tool call cannot trigger the repair", !r.ok);
    check("and issues no commands at all", f.calls().length === 0, JSON.stringify(f.calls()));
    check(
      "the message names the stale connection, not a WSL VM that isn't there",
      !!r.error?.includes("stale podman connection") && !r.error.includes("leftover WSL"),
      JSON.stringify(r.error),
    );
    check(
      "and tells the agent retrying is pointless",
      !!r.error?.includes("RETRYING THIS TOOL WILL NOT HELP"),
    );
  }

  // ── 5. A failing `connection rm` is reported, not swallowed ──────────
  {
    const f = fakePodman({ distros: [], connections: ["podman-machine-default"] });
    const deps: OrphanRepairDeps = { ...f.deps, removeConnection: async () => false };
    const r = await orphanedMachineFailure(true, deps);
    check("a refused connection rm fails loudly", !r.ok);
    check(
      "with the exact command to run by hand",
      !!r.error?.includes("podman system connection rm podman-machine-default"),
      JSON.stringify(r.error),
    );
    check("and never reaches init", !f.calls().includes("init"), JSON.stringify(f.calls()));
  }

  console.log(failures ? `\n${failures} FAILED` : "\nALL PODMAN ORPHAN CHECKS PASSED");
  process.exit(failures ? 1 : 0);
};

void run();
