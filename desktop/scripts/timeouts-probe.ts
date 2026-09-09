/**
 * How long to wait on a model, and where that number comes from.
 *
 * This decides whether a request is abandoned, so the interesting cases are
 * the ones where a wrong answer is silent: a local endpoint mistaken for a
 * remote one gets five minutes and dies mid-prompt; a model's explicit 0
 * treated as "unset" gets a watchdog it was told not to have.
 *
 *   npm run smoke:timeouts
 */

import {
  DEFAULT_TIMEOUTS,
  isLocalEndpoint,
  streamTimeoutMs,
  withDeadline,
  asDeadlineError,
} from "../src/main/llm/timeouts";
import type { ProviderKind } from "../src/main/provider/types";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) failures++;
};

const CFG = { remoteSec: 300, localSec: 1800 };
const at = (
  baseURL: string,
  kind: ProviderKind = "openai",
  streamTimeoutSec?: number,
): number =>
  streamTimeoutMs(
    { kind, baseURL, ...(streamTimeoutSec !== undefined ? { streamTimeoutSec } : {}) },
    CFG,
  );

// ─── Which side of the network is it on ─────────────────────────────────

check("localhost is local", isLocalEndpoint("http://localhost:8080/v1"));
check("127.0.0.1 is local", isLocalEndpoint("http://127.0.0.1:17171/v1"));
// The whole 127.0.0.0/8 block is loopback, not just the one address people
// type. A server bound to 127.0.0.2 is on this machine by definition.
check("so is the rest of 127/8", isLocalEndpoint("http://127.0.0.2:1234/v1"));
check("0.0.0.0 is local", isLocalEndpoint("http://0.0.0.0:8080/v1"));
check("a .local host is local", isLocalEndpoint("http://studio.local:1234/v1"));
check("an API is not", !isLocalEndpoint("https://api.anthropic.com"));
check(
  "and neither is a host that merely mentions one",
  !isLocalEndpoint("https://localhost.evil.example.com/v1"),
  "localhost.evil.example.com",
);
// Garbage must not read as local: erring that way hands a broken address the
// long timeout, and the request hangs for half an hour instead of failing.
check("an unparseable address is treated as remote", !isLocalEndpoint("not a url"));

// ─── What that means in milliseconds ────────────────────────────────────

check("an API gets the remote default", at("https://api.openai.com/v1") === 300_000);
check("a local server gets the local one", at("http://localhost:8080/v1") === 1_800_000);
// Monet Local is this app's own server. Reached over the LAN it is still
// llama.cpp reading a prompt slowly, so the address must not demote it.
check(
  "Monet Local is local wherever it is reached",
  at("http://192.168.1.40:17171/v1", "monet-local") === 1_800_000,
);
check(
  "a model's own number wins over both",
  at("https://api.openai.com/v1", "openai", 45) === 45_000,
);
// 0 is a VALUE, not an absence: someone who typed it asked for no watchdog.
check(
  "and zero is one of those numbers",
  at("https://api.openai.com/v1", "openai", 0) === 0,
);
check("nonsense falls back rather than disabling the watchdog", at("x", "openai", -5) === 300_000);
check(
  "the defaults are the ones the code ships with",
  DEFAULT_TIMEOUTS.remoteSec === 300 && DEFAULT_TIMEOUTS.localSec === 1800,
  DEFAULT_TIMEOUTS,
);

// ─── The signal ─────────────────────────────────────────────────────────

// No deadline means no listener and no timer: "wait as long as it takes"
// must cost nothing, including on a caller that passed no signal at all.
check("no deadline, no signal invented", withDeadline(undefined, 0) === undefined);
const caller = new AbortController();
check(
  "no deadline leaves the caller's signal untouched",
  withDeadline(caller.signal, 0) === caller.signal,
);
const combined = withDeadline(caller.signal, 60_000);
check("a deadline makes a new signal", !!combined && combined !== caller.signal);
check("which is not aborted yet", combined?.aborted === false);
caller.abort();
check("and follows the caller", combined?.aborted === true);

// ─── What the caller is told ────────────────────────────────────────────

const abortErr = new DOMException("The operation was aborted", "AbortError");
const timeoutErr = new DOMException("The operation was aborted", "TimeoutError");
check(
  "a deadline hit reads as one",
  /within 30s/.test(asDeadlineError(timeoutErr, 30_000).message),
  asDeadlineError(timeoutErr, 30_000).message,
);
// Stop is not a failure, and must not be reported as one — the user knows
// what they pressed.
const stopped = new AbortController();
stopped.abort();
check(
  "the user's own Stop keeps its own words",
  asDeadlineError(abortErr, 30_000, stopped.signal).name === "AbortError",
);
check(
  "an ordinary failure passes through",
  asDeadlineError(new Error("ECONNREFUSED"), 30_000).message === "ECONNREFUSED",
);

console.log(failures ? `\n${failures} FAILED` : "\nALL TIMEOUT CHECKS PASSED");
process.exit(failures ? 1 : 0);
