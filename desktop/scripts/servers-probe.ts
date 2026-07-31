/**
 * The dev-server list a project declares.
 *
 * .monet/servers.json is a file people edit by hand and commit, so it arrives
 * malformed sooner or later — and the failure mode to avoid is the panel going
 * blank because one entry had a string where a number belonged. Every field is
 * checked, and a bad entry is dropped rather than taking its neighbours with
 * it.
 *
 * The port rules are the other half. A server the panel can start but cannot
 * open is worse than one it never offered: the button works, something spins
 * up, and nothing appears.
 */

import {
  mergeDetected,
  parseServers,
  portFromOutput,
  portOf,
  suggestFromPackage,
  type ServerState,
} from "../src/main/browser/servers";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
};

// ── 1. The shape people actually write ────────────────────────────────
{
  const list = parseServers(
    JSON.stringify({
      servers: [
        { id: "lk", name: "lk-dev", command: "npm run dev", port: 3000 },
        { name: "api", command: "go run ./cmd/api", port: 8080, cwd: "server" },
      ],
    }),
  );
  check("both entries survive", list.length === 2, list.length);
  check("the id is kept", list[0]?.id === "lk");
  check("cwd is kept when given", list[1]?.cwd === "server");
  check("cwd is absent when not", list[0]?.cwd === undefined);

  // A bare array is the other thing people write.
  check("a bare array works too", parseServers('[{"command":"x","port":1234}]').length === 1);
}

// ── 2. One bad entry does not empty the list ──────────────────────────
{
  const list = parseServers(
    JSON.stringify({
      servers: [
        { name: "ok", command: "npm run dev", port: 3000 },
        { name: "no command", port: 4000 },
        { name: "no port", command: "npm start" },
        { name: "port out of range", command: "npm start", port: 99999 },
        { name: "blank command", command: "   ", port: 5000 },
        null,
        "nonsense",
        { name: "fine too", command: "npm run api", port: 8080 },
      ],
    }),
  );
  check("only the valid ones are kept", list.length === 2, list.map((s) => s.name).join(","));
  check(
    "and they are the right two",
    list[0]?.name === "ok" && list[1]?.name === "fine too",
    list.map((s) => s.name).join(","),
  );
}

// ── 2b. A port written as text is a typo with one meaning ────────────
//
// Deliberately lenient: "3000" in a hand-edited file is unambiguous, and
// dropping the server over it hides one the user plainly declared. "abc" is
// not a number at all and still goes.
{
  const ok = parseServers('[{"command":"npm start","port":"3000"}]');
  check("a numeric string is accepted", ok.length === 1, ok.length);
  check("and normalised to a number", ok[0]?.port === 3000, typeof ok[0]?.port);
  check(
    "a non-numeric string is not",
    parseServers('[{"command":"npm start","port":"abc"}]').length === 0,
  );
}

// ── 3. Nothing throws on junk ─────────────────────────────────────────
{
  check("not JSON at all", parseServers("{{{").length === 0);
  check("an empty file", parseServers("").length === 0);
  check("a JSON string", parseServers('"hello"').length === 0);
  check("a JSON number", parseServers("42").length === 0);
  check("an object with no servers", parseServers("{}").length === 0);
}

// ── 4. Missing names get one, so the list is never blank rows ─────────
{
  const list = parseServers('[{"command":"npm start","port":4321}]');
  check("a nameless server is named by its port", list[0]?.name === ":4321", list[0]?.name);
  check("and gets an id", !!list[0]?.id, list[0]?.id);
}

// ── 5. Reading a port out of a command ────────────────────────────────
{
  check("--port 4321", portOf("vite --port 4321") === 4321);
  check("--port=4321", portOf("vite --port=4321") === 4321);
  check("-p 8080", portOf("http-server -p 8080") === 8080);
  check("PORT=8788", portOf("PORT=8788 node server.js") === 8788);
  check("no port at all", portOf("npm run build") === null);
  check(
    "a number that is not a port is not one",
    portOf("node --max-old-space-size=4096 app.js") === null,
    portOf("node --max-old-space-size=4096 app.js"),
  );
}

// ── 6. Suggestions: only scripts we could actually open ───────────────
{
  const pkg = JSON.stringify({
    scripts: {
      dev: "vite --port 5173",
      start: "next start",
      "dev:api": "PORT=8080 go run ./cmd/api",
      build: "tsc && vite build",
      test: "vitest run --port 1234",
    },
  });
  const out = suggestFromPackage(pkg);
  const names = out.map((s) => s.name).sort().join(",");

  check("a dev script with a port is offered", names.includes("dev"), names);
  check("so is a namespaced one", names.includes("dev:api"), names);
  check(
    "a script with no port is NOT offered — nothing to open",
    !names.includes("start"),
    names,
  );
  check("build is not a server", !names.includes("build"), names);
  check("neither is test, port or no port", !names.includes("test"), names);
  check(
    "the command is what npm would run",
    out.find((s) => s.name === "dev")?.command === "npm run dev",
    out.find((s) => s.name === "dev")?.command,
  );
  check("no scripts, no suggestions", suggestFromPackage("{}").length === 0);
  check("junk json, no suggestions", suggestFromPackage("nope").length === 0);
}

// ── 7. A server nobody declared still shows up ────────────────────────
//
// The list used to be only what the project file declared, so a server the
// AGENT started did not appear at all — it ran `npm run dev` through a shell,
// which knows nothing about .monet/servers.json. A list of dev servers that
// omits the running ones answers a question nobody asked.
{
  const declared: ServerState[] = [
    {
      id: "web",
      name: "lk-dev",
      command: "npm run dev",
      port: 3000,
      declared: true,
      status: "stopped",
    },
  ];
  const detected = [
    { port: 3000, url: "http://localhost:3000/", title: "Portfolio" },
    { port: 5173, url: "http://localhost:5173/", title: "Vite app" },
  ];

  const merged = mergeDetected(declared, detected);
  check("the undeclared one is added", merged.length === 2, merged.length);
  check(
    "a declared port is not duplicated by detecting it",
    merged.filter((s) => s.port === 3000).length === 1,
    merged.filter((s) => s.port === 3000).length,
  );
  check(
    "and that row keeps its own command, not the detected blank",
    merged.find((s) => s.port === 3000)?.command === "npm run dev",
  );

  const found = merged.find((s) => s.port === 5173);
  check("the found one is marked as not declared", found?.declared === false);
  check("it is running, by definition", found?.status === "running");
  check("and is somebody else's process", found?.externallyRunning === true);
  check(
    "it has no command, because there is none to know",
    found?.command === "",
    JSON.stringify(found?.command),
  );
  check("it is named by the page", found?.name === "Vite app", found?.name);

  const nameless = mergeDetected([], [{ port: 8080, url: "u", title: "" }]);
  check(
    "a nameless one falls back to its port",
    nameless[0]?.name === ":8080",
    nameless[0]?.name,
  );

  check("nothing detected changes nothing", mergeDetected(declared, []).length === 1);
  check("nothing declared still lists what is up", mergeDetected([], detected).length === 2);
}

// ── 8. The port a server actually took ────────────────────────────────
//
// Declaring 5173 does not get you 5173. Vite finds it busy, moves to 5174 and
// says so — and waiting on the declared number reported a running server as a
// failure, then offered a stop button for a port with nothing on it.
//
// The prose is a trap: "Port 5173 is in use, trying another one" names the
// port that did NOT work, and it comes BEFORE the one that did.
{
  const ESC = String.fromCharCode(27);
  const viteOutput = [
    "> website@0.0.0 dev",
    "> vite",
    "",
    "Port 5173 is in use, trying another one...",
    "",
    `  ${ESC}[32m${ESC}[1mVITE${ESC}[22m v8.2.0${ESC}[39m  ${ESC}[2mready in 395 ms${ESC}[22m`,
    "",
    `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5174${ESC}[22m/${ESC}[39m`,
    `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mNetwork${ESC}[22m: use ${ESC}[1m--host${ESC}[22m to expose`,
  ].join("\n");

  check(
    "the port it moved TO wins over the one it left",
    portFromOutput(viteOutput) === 5174,
    portFromOutput(viteOutput),
  );

  // The URL is split by colour codes mid-number in real Vite output; stripping
  // ANSI first is what makes it readable at all.
  check(
    "colour codes inside the URL do not hide it",
    portFromOutput(`http://localhost:${ESC}[1m3001${ESC}[22m/`) === 3001,
    portFromOutput(`http://localhost:${ESC}[1m3001${ESC}[22m/`),
  );

  check(
    "the LAST url wins, not the first",
    portFromOutput("http://localhost:3000/\nhttp://localhost:3001/") === 3001,
  );
  check(
    "127.0.0.1 counts too",
    portFromOutput("Serving at http://127.0.0.1:8080/") === 8080,
  );

  // Servers that print no URL still say something usable.
  check(
    "listening on port N, when there is no URL",
    portFromOutput("Server listening on port 4000") === 4000,
  );
  check(
    "but only when the sentence means it worked",
    portFromOutput("Port 5173 is in use, trying another one...") === null,
    portFromOutput("Port 5173 is in use, trying another one..."),
  );
  check("nothing to find is null", portFromOutput("compiling...") === null);
  check("empty output is null", portFromOutput("") === null);
}

console.log(failures === 0 ? "\nservers probe OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
