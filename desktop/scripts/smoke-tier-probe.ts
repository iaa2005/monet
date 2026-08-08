/**
 * "Actually run it" — everything about it except the window.
 *
 * The value of this check is entirely in its signal-to-noise. A dev server
 * is a loud place: HMR chatter, the React devtools advert, a favicon
 * nobody added, a source map that was never built. Report those as
 * problems and the user switches the feature off, which costs them the
 * real ones too — so the filter is the feature.
 *
 * The rest is the choosing: which server, when not to bother, and how a
 * failure reads to a model that has to act on it.
 *
 *   npm run smoke:smoketier
 */

import {
  isNoise,
  judgeSmoke,
  pickServer,
  requestProblem,
  smokePrompt,
  smokeSummary,
  MAX_PROBLEMS,
  type SmokeProblem,
} from "../src/main/verify/smoke.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(
      `FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
    );
  }
}

const server = (id: string, name: string, command: string, port = 3000) => ({
  id,
  name,
  command,
  port,
});

// ─── Which server ───────────────────────────────────────────────────────

{
  check("no servers, no choice", pickServer([]) === null);
  check(
    "the dev one wins",
    pickServer([
      server("a", "api", "node server.js"),
      server("b", "dev", "vite"),
    ])?.id === "b",
  );
  check(
    "…however it is spelled",
    pickServer([
      server("a", "backend", "python app.py"),
      server("b", "web", "npm run dev"),
    ])?.id === "b",
  );
  check(
    "start beats a plain command",
    pickServer([
      server("a", "worker", "node worker.js"),
      server("b", "start", "npm start"),
    ])?.id === "b",
  );
  check(
    "and one server is the choice, whatever it is called",
    pickServer([server("a", "worker", "node worker.js")])?.id === "a",
  );
}

// ─── What counts as a problem ───────────────────────────────────────────

{
  check("a real uncaught error is reported", !isNoise("TypeError: x is not a function"));
  check("…and a failed import", !isNoise("Failed to resolve module ./missing"));

  const noise = [
    "Download the React DevTools for a better development experience",
    "[vite] connected.",
    "[HMR] Waiting for update signal",
    "GET /favicon.ico 404",
    "'webkitStorageInfo' is deprecated",
    "DevTools failed to load source map: x.js.map",
  ];
  for (const n of noise)
    check(`NOISE IS NOT A PROBLEM: "${n.slice(0, 34)}…"`, isNoise(n), n);
}

{
  check("a 500 is a problem", requestProblem("/api/items", 500) !== null);
  check("a 404 on a real path is a problem", requestProblem("/api/items", 404) !== null);
  check("a 200 is not", requestProblem("/api/items", 200) === null);
  check("a missing favicon is not", requestProblem("/favicon.ico", 404) === null);
  check(
    "and neither is a source map the dev server never built",
    requestProblem("/src/app.js.map", 404) === null,
  );
  check(
    "the message names the status and the path",
    requestProblem("/api/items", 500) === "500 on /api/items",
  );
}

// ─── The verdict ────────────────────────────────────────────────────────

{
  const clean = judgeSmoke("http://localhost:3000/", [
    { kind: "console", text: "[vite] connected." },
    { kind: "console", text: "Download the React DevTools for a better experience" },
  ]);
  check("a page whose only output is noise is CLEAN", clean.status === "clean", clean);

  const dirty = judgeSmoke("http://localhost:3000/", [
    { kind: "console", text: "TypeError: cannot read 'map' of undefined" },
    { kind: "console", text: "[vite] connected." },
    { kind: "request", text: "500 on /api/items" },
  ]);
  check("a page with a real error is not", dirty.status === "problems", dirty);
  check("…and the noise is gone from the report", dirty.problems.length === 2, dirty.problems);

  const repeated = judgeSmoke(
    "u",
    Array.from({ length: 20 }, () => ({
      kind: "console" as const,
      text: "TypeError: same failure echoing",
    })),
  );
  check(
    "the same failure repeated is reported ONCE",
    repeated.problems.length === 1,
    repeated.problems,
  );

  const many: SmokeProblem[] = Array.from({ length: 20 }, (_, i) => ({
    kind: "console",
    text: `error number ${i}`,
  }));
  check(
    "and a cascade is capped rather than pasted whole",
    judgeSmoke("u", many).problems.length === MAX_PROBLEMS,
  );
}

// ─── How it reads ───────────────────────────────────────────────────────

{
  const outcome = judgeSmoke("http://localhost:5173/", [
    { kind: "console", text: "TypeError: cannot read 'map' of undefined" },
    { kind: "empty", text: "the page rendered no text at all" },
  ]);
  const p = smokePrompt(outcome);
  check("the prompt says where it looked", p.includes("http://localhost:5173/"));
  check("…quotes the error", p.includes("cannot read 'map' of undefined"));
  check(
    "…says this came from the running app, not a linter",
    /running app/i.test(p) && /compiles and still does this/i.test(p),
  );
  // Whitespace-tolerant: the prompt is wrapped for reading, and a test that
  // breaks when a line is re-wrapped tests the formatting, not the meaning.
  check(
    "…and lets the model push back rather than forcing a fix",
    /not\s+actually yours to fix/i.test(p),
    p,
  );

  check(
    "a clean run says so in one line",
    /runs/.test(smokeSummary(judgeSmoke("http://x/", []))),
  );
  check(
    "a skipped run says WHY",
    smokeSummary({
      status: "skipped",
      problems: [],
      reason: "no dev server in this project",
    }).includes("no dev server in this project"),
  );
}

console.log(
  failures ? `\n${failures} FAILED` : "\nA DEV SERVER'S NOISE IS NOT A BUG REPORT",
);
process.exit(failures ? 1 : 0);
