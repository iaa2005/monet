/**
 * What a Home preview server is allowed to expose.
 *
 * The bug this replaces: a Home chat asked for "run it as a site", the model
 * used the Code workspace's DevServer tool, and `python -m http.server` came
 * up on the HOST — cwd = the project root, bound to 0.0.0.0. The user's
 * repository, `.git`, and the app's own data folder (every chat, in plain
 * SQLite) were served to the whole local network. Then the model copied its
 * HTML out of the sandbox into that root to make the page load.
 *
 * These are the properties that make the replacement safe, asserted on the
 * argv the app actually builds — no Podman needed, so it runs everywhere:
 *
 *   1. the published port binds 127.0.0.1, never 0.0.0.0 or a LAN address;
 *   2. the only host path in the container is the chat's own sandbox folder;
 *   3. nothing opts out of the container's isolation (no --network=host, no
 *      --privileged, no docker socket);
 *   4. Home advertises the sandbox server and NOT DevServer; Code the reverse.
 */

import { serveArgs, staticServeCommand } from "../src/main/sandbox/podman-server";
import {
  TRANSIENT_MACHINE_ERROR,
  machineName,
} from "../src/main/sandbox/podman-engine";
import { spaceAllows } from "../src/main/agent/space-tools";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const DIR = "D:\\data\\.monet\\sandboxes\\chat-1";
const args = serveArgs({
  container: "monet-serve-chat-1",
  dir: DIR,
  hostPort: 8731,
  containerPort: 8000,
  command: staticServeCommand(8000),
});
const argv = args.join(" ");

// ── 1. The port answers on this machine only ──────────────────────────
{
  const pubIdx = args.indexOf("-p");
  const publish = pubIdx >= 0 ? args[pubIdx + 1] : "";
  check("the port is published", pubIdx >= 0, publish);
  check(
    "and bound to loopback, not every interface",
    publish.startsWith("127.0.0.1:"),
    publish,
  );
  check(
    "host and container ports are both named (no bare -p 8000)",
    publish.split(":").length === 3,
    publish,
  );
  // The container-side bind MUST be 0.0.0.0 — that is the container's own
  // namespace, and binding 127.0.0.1 there makes the publish unreachable.
  check(
    "the command binds 0.0.0.0 INSIDE the container",
    staticServeCommand(8000).includes("--bind 0.0.0.0"),
    staticServeCommand(8000),
  );
}

// ── 2. Only the chat's own folder is mounted ──────────────────────────
{
  const mounts = args.filter((a, i) => args[i - 1] === "-v");
  check("exactly one host path is mounted", mounts.length === 1, mounts.join(", "));
  check("and it is the chat's sandbox folder", mounts[0] === `${DIR}:/work`, mounts[0]);
  check("served with /work as the working directory", argv.includes("-w /work"));
  // A traversal out of /work reaches the container's own filesystem — never
  // the user's, because nothing else from the host is in there.
  check(
    "no host root, home directory or data dir is mounted",
    !mounts.some((m) => /^[A-Za-z]:\\(:|$)|^\/:|\.monet(-prod)?[/\\]?:/.test(m)) &&
      !mounts.some((m) => m.startsWith("/:") || m.startsWith("C:\\:")),
    mounts.join(", "),
  );
}

// ── 3. The container keeps its walls ──────────────────────────────────
{
  check("no host networking", !argv.includes("--network=host") && !argv.includes("--net=host"));
  check("not privileged", !argv.includes("--privileged"));
  check("no container runtime socket is passed in", !argv.includes("docker.sock") && !argv.includes("podman.sock"));
  check("runs detached", args.includes("-d"));
  check("and removes itself when it stops", args.includes("--rm"));
  check("under a name derived from the chat", argv.includes("--name monet-serve-chat-1"));
}

// ── 4. Each space gets the server it can have ─────────────────────────
{
  check("Home advertises ServeSandbox", spaceAllows("ServeSandbox", "home"));
  // DevServer's own gate lives in isSpaceToolAllowed (it needs the browser
  // setting), and that is where Home is refused — but the space list must not
  // hand it out either.
  check("Home's list does not include DevServer", !spaceAllows("DevServer", "home"));
  check("Code keeps DevServer", spaceAllows("DevServer", "code"));
}

// ── 5. A busy machine is not a broken one ─────────────────────────────
//
// Podman rewrites its machine JSON as it works; a `machine list` landing
// mid-write says "unable to read machine config … .json". Reported raw, that
// reads as corruption — a model diagnosed exactly that and told the user to
// delete their machine, while Settings said "Podman is ready" the whole
// time. These messages get a retry; a genuinely broken setup must not.
{
  const retried = [
    String.raw`unable to read machine config C:\Users\x\.config\containers\podman\machine\wsl\podman-machine-default*.json`,
    "Error: unexpected end of JSON input",
    "The process cannot access the file because it is being used by another process.",
    "Error: could not obtain lock on machine",
  ];
  for (const msg of retried)
    check(`retried: ${msg.slice(0, 44)}…`, TRANSIENT_MACHINE_ERROR.test(msg));

  const reported = [
    "Error: no such machine podman-machine-default",
    "Error: WSL is not installed on this system",
    "Error: cannot connect to Podman socket",
    "Error: image not known",
  ];
  for (const msg of reported)
    check(`reported as-is: ${msg.slice(0, 40)}`, !TRANSIENT_MACHINE_ERROR.test(msg));
}

// ── 6. The machine's name is a name, not a marker ─────────────────────
//
// `podman machine list --format {{.Name}}` marks the DEFAULT machine with a
// trailing asterisk, inside the field. We fed that straight back to
// `podman machine start`, Windows rejected `*` in the config path (error
// 123: "The filename, directory name, or volume label syntax is incorrect"),
// and the app told the user their machine was damaged and to rebuild it —
// while Settings still said "Podman is ready". Reproduced exactly:
//   podman machine start "podman-machine-default*"
//   Error: open …\wsl\podman-machine-default*.json: …syntax is incorrect.
{
  check(
    "the default-machine marker is not part of the name",
    machineName("podman-machine-default*") === "podman-machine-default",
    machineName("podman-machine-default*"),
  );
  check(
    "a plain name is untouched",
    machineName("podman-machine-default") === "podman-machine-default",
  );
  check(
    "whitespace around either form is trimmed",
    machineName("  my-machine*  ") === "my-machine",
    machineName("  my-machine*  "),
  );
  check("an empty line is not a machine", machineName("   ") === undefined);
  check("nothing is not a machine", machineName(undefined) === undefined);
  // The real two-machine listing shape, tab-separated as we ask for it.
  const listed = "podman-machine-default*\ttrue\nother-machine\tfalse";
  const first = machineName(listed.split("\n")[0].split("\t")[0]);
  check(
    "parsed out of a real listing, the name is usable as an argument",
    first === "podman-machine-default" && !first.includes("*"),
    first,
  );
}

console.log(
  failures === 0 ? "\nsandbox server probe OK" : `\n${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
