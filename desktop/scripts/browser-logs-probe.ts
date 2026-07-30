/**
 * Reading CDP events, and reading the log back.
 *
 * The whole point of writing traffic to a file is that the model pays for one
 * line ("2 errors in 31 messages") instead of the traffic. That trade only
 * works if the count is right and the filter finds the error — so the parts
 * worth pinning are the ones where the protocol is easy to misread:
 *
 *  - A failed request is announced by BOTH the Network domain and the Log
 *    domain. Count both and every failure is a double, which turns one broken
 *    endpoint into "2 errors" and sends the model looking for a second bug.
 *  - A cancelled request is the page navigating away, not a failure.
 *  - An iframe navigating is not the page navigating; resetting counters on it
 *    erases the errors from the page that just loaded.
 *  - Console arguments arrive as `value` for primitives and `description` for
 *    objects and errors — reading only one leaves blank lines.
 *  - `limit` must keep the LAST n lines. A fresh break is at the end of a log,
 *    and taking the first n reliably returns the page's startup noise instead.
 */

import {
  filterLines,
  formatEvent,
  stampOf,
  type LogOutcome,
} from "../src/main/browser/log-format";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
};

const STAMP = "12:00:00.000";
const fire = (
  method: string,
  params: Record<string, unknown>,
  inFlight = new Map<string, string>(),
): LogOutcome => formatEvent(method, params, inFlight, STAMP);

const isLine = (
  o: LogOutcome,
): o is { kind: "console" | "network"; line: string; isError: boolean } =>
  !!o && !("reset" in o);

// ── 1. Console arguments come in two shapes ───────────────────────────
{
  const primitive = fire("Runtime.consoleAPICalled", {
    type: "log",
    args: [{ type: "string", value: "hello" }, { type: "number", value: 42 }],
  });
  check(
    "primitive args read `value`",
    isLine(primitive) && primitive.line.includes("hello 42"),
    isLine(primitive) ? primitive.line : primitive,
  );

  const object = fire("Runtime.consoleAPICalled", {
    type: "error",
    args: [{ type: "object", description: "TypeError: x is not a function" }],
  });
  check(
    "object args read `description`",
    isLine(object) && object.line.includes("TypeError: x is not a function"),
    isLine(object) ? object.line : object,
  );
  check("console error is flagged", isLine(object) && object.isError);

  const warn = fire("Runtime.consoleAPICalled", {
    type: "warning",
    args: [{ value: "deprecated" }],
  });
  // CDP says "warning"; every log reader in the world says "warn".
  check(
    "warning is written as warn",
    isLine(warn) && / warn /.test(warn.line),
    isLine(warn) ? warn.line : warn,
  );
  check("a warning is not an error", isLine(warn) && !warn.isError);
}

// ── 2. Exceptions carry a location, one-based ─────────────────────────
{
  const out = fire("Runtime.exceptionThrown", {
    exceptionDetails: {
      text: "Uncaught",
      exception: { description: "ReferenceError: foo is not defined" },
      url: "http://localhost:3000/app.js",
      lineNumber: 41,
    },
  });
  check(
    "exception names the file and line",
    isLine(out) && out.line.includes("app.js:42"),
    isLine(out) ? out.line : out,
  );
  check("exception is an error", isLine(out) && out.isError);
}

// ── 3. Network failures are NOT counted twice ─────────────────────────
{
  const viaLog = fire("Log.entryAdded", {
    entry: {
      source: "network",
      level: "error",
      text: "Failed to load resource: 500",
      url: "http://localhost:3000/api/x",
    },
  });
  check("network errors from the Log domain are dropped", viaLog === null, viaLog);

  const viaConsole = fire("Log.entryAdded", {
    entry: { source: "javascript", level: "error", text: "boom" },
  });
  check(
    "javascript errors from the Log domain are kept",
    isLine(viaConsole) && viaConsole.isError,
  );
}

// ── 4. A failed request names what failed ─────────────────────────────
{
  const inFlight = new Map<string, string>();
  fire(
    "Network.requestWillBeSent",
    { requestId: "r1", request: { method: "POST", url: "http://localhost:3000/api/save" } },
    inFlight,
  );
  const failed = fire(
    "Network.loadingFailed",
    { requestId: "r1", errorText: "net::ERR_CONNECTION_REFUSED" },
    inFlight,
  );
  check(
    "failure carries the method and URL it was sent with",
    isLine(failed) &&
      failed.line.includes("POST http://localhost:3000/api/save") &&
      failed.line.includes("ERR_CONNECTION_REFUSED"),
    isLine(failed) ? failed.line : failed,
  );
  check("failure is an error", isLine(failed) && failed.isError);
  check("the request is forgotten once resolved", inFlight.size === 0, inFlight.size);

  const cancelled = fire("Network.loadingFailed", {
    requestId: "r2",
    errorText: "net::ERR_ABORTED",
    canceled: true,
  });
  check("a cancelled request is not a failure", cancelled === null, cancelled);
}

// ── 5. Responses: status decides, size is readable ────────────────────
{
  const inFlight = new Map<string, string>();
  fire(
    "Network.requestWillBeSent",
    { requestId: "r3", request: { method: "GET", url: "http://localhost:3000/api/items" } },
    inFlight,
  );
  const okRes = fire(
    "Network.responseReceived",
    {
      requestId: "r3",
      type: "XHR",
      response: { status: 200, encodedDataLength: 2048, mimeType: "application/json" },
    },
    inFlight,
  );
  check(
    "200 is not an error, size is human",
    isLine(okRes) && !okRes.isError && okRes.line.includes("2 kB"),
    isLine(okRes) ? okRes.line : okRes,
  );

  const bad = fire("Network.responseReceived", {
    requestId: "r4",
    response: { status: 500, url: "http://localhost:3000/api/x" },
  });
  check("500 is an error", isLine(bad) && bad.isError);

  const notFound = fire("Network.responseReceived", {
    requestId: "r5",
    response: { status: 404, url: "http://localhost:3000/missing.png" },
  });
  check("404 is an error", isLine(notFound) && notFound.isError);
}

// ── 6. Only the main frame resets the counters ────────────────────────
{
  const main = fire("Page.frameNavigated", { frame: { id: "1" } });
  check("main frame navigation resets", !!main && "reset" in main, main);

  const iframe = fire("Page.frameNavigated", { frame: { id: "2", parentId: "1" } });
  check("an iframe does not reset", iframe === null, iframe);
}

// ── 7. Filtering finds the error and keeps the newest ─────────────────
{
  const lines = [
    "12:00:00.000 log   starting up",
    "12:00:01.000 warn  deprecated api",
    "12:00:02.000 error TypeError: boom",
    "12:00:03.000 log   still going",
    "12:00:04.000 FAILED GET /api/x — net::ERR_FAILED",
    "12:00:05.000 500 GET http://localhost/api/y (XHR)",
  ];

  const errors = filterLines(lines, { level: "error" });
  check(
    "level=error keeps error, FAILED and 5xx",
    errors.matched === 3,
    errors.lines.join(" | "),
  );

  const warns = filterLines(lines, { level: "warn" });
  check("level=warn also keeps warnings", warns.matched === 4, warns.matched);

  const grep = filterLines(lines, { grep: "TypeError" });
  check("grep narrows to one", grep.matched === 1 && grep.lines.length === 1);

  const caseless = filterLines(lines, { grep: "typeerror" });
  check("grep is case-insensitive", caseless.matched === 1);

  // A model writing a literal `?` or an unbalanced bracket should get lines
  // back, not a regex parse error.
  const literal = filterLines(
    [...lines, "12:00:06.000 log   what? (unclosed"],
    { grep: "what? (unclosed" },
  );
  check(
    "an invalid regex falls back to a literal search",
    literal.matched === 1,
    literal.lines.join(" | "),
  );

  const last = filterLines(lines, { limit: 2 });
  check(
    "limit keeps the LAST n, not the first",
    last.lines.length === 2 && last.lines[1] === lines[5],
    last.lines.join(" | "),
  );
  check("matched counts before the limit", filterLines(lines, { limit: 2 }).matched === 6);
}

// ── 8. The stamp is the time, not the date ────────────────────────────
{
  const s = stampOf(new Date("2026-07-31T12:34:56.789Z"));
  check("stamp is hh:mm:ss.mmm", s === "12:34:56.789", s);
}

console.log(failures === 0 ? "\nbrowser logs probe OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
