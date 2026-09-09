/**
 * How long to wait on a model before giving up.
 *
 * The watchdog exists for a connection that has died without saying so. It
 * was a 300-second constant in both clients, and on a server running on this
 * machine that number is not a safety net but a guarantee of failure:
 * measured on a 27B at Q4 on this CPU, the prompt is read at about ten tokens
 * a second, so a Code turn — twenty thousand tokens of system prompt and tool
 * schemas before the user's first word — spends half an hour in silence
 * before the first byte of the answer. The watchdog fired on the first turn
 * of every chat, the loop read the empty result as "the model finished", and
 * the nudge sent the whole request again.
 *
 * So the number is a setting, and its default depends on where the model is.
 * A remote API that has said nothing for five minutes is broken. A local one
 * is usually just working.
 *
 * Two numbers rather than one per provider, because the distinction that
 * matters is not who the vendor is but whether the wire has a network on it.
 * A per-model override sits on top for the case neither number fits.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";
import type { ProviderKind } from "../provider/types.js";

export interface TimeoutConfig {
  /** Seconds of silence before a remote stream is abandoned. 0 = never. */
  remoteSec: number;
  /** The same, for a server on this machine. 0 = never. */
  localSec: number;
}

/**
 * Five minutes for the network, half an hour for this machine.
 *
 * The local figure is not a guess: 1800 s at the measured ten tokens a second
 * is eighteen thousand tokens of prompt, which is one Code turn as the app
 * builds it today. It should shrink as the prompt does (see the prompt-diet
 * stage), and anyone whose machine is slower than that can set it higher or
 * to 0.
 */
export const DEFAULT_TIMEOUTS: TimeoutConfig = { remoteSec: 300, localSec: 1800 };

function configPath(): string {
  return join(getDataDir(), "timeouts.json");
}

function clampSec(v: unknown, fallback: number): number {
  const n = Number(v);
  // 0 is meaningful — "no watchdog" — so it is not the same as absent. A day
  // is the ceiling: past that the setting is indistinguishable from off, and
  // a stray keystroke should not pin a request open for a week.
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), 86_400);
}

export function getTimeoutConfig(): TimeoutConfig {
  try {
    const p = configPath();
    if (!existsSync(p)) return { ...DEFAULT_TIMEOUTS };
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<TimeoutConfig>;
    return {
      remoteSec: clampSec(raw.remoteSec, DEFAULT_TIMEOUTS.remoteSec),
      localSec: clampSec(raw.localSec, DEFAULT_TIMEOUTS.localSec),
    };
  } catch {
    return { ...DEFAULT_TIMEOUTS };
  }
}

export function setTimeoutConfig(patch: Partial<TimeoutConfig>): TimeoutConfig {
  const next = { ...getTimeoutConfig(), ...patch };
  const clean: TimeoutConfig = {
    remoteSec: clampSec(next.remoteSec, DEFAULT_TIMEOUTS.remoteSec),
    localSec: clampSec(next.localSec, DEFAULT_TIMEOUTS.localSec),
  };
  try {
    writeFileSync(configPath(), JSON.stringify(clean, null, 2), "utf-8");
  } catch {
    /* a read-only data folder is not worth failing a request over */
  }
  return clean;
}

/**
 * Is this endpoint on the machine the app is running on?
 *
 * By the host, not by the provider's kind: someone pointing an "openai" kind
 * at their own llama.cpp is the common case, and it is the one that suffers
 * most from the remote timeout. `.local` counts too — a Mac on the desk
 * across the room is a local server for this purpose.
 */
export function isLocalEndpoint(baseURL: string): boolean {
  let host: string;
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    // Not a URL we can parse — assume the network, which is the safe answer:
    // it errs towards a shorter wait, not towards hanging forever.
    return false;
  }
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (host === "0.0.0.0") return true;
  // 127.0.0.0/8 is all loopback, not just .0.1.
  return /^127\./.test(host);
}

/** What the watchdog should be set to for this endpoint, in milliseconds. */
export function streamTimeoutMs(
  endpoint: { kind: ProviderKind; baseURL: string; streamTimeoutSec?: number },
  cfg: TimeoutConfig = getTimeoutConfig(),
): number {
  // The model's own number wins whenever it has one, 0 included.
  if (endpoint.streamTimeoutSec !== undefined)
    return clampSec(endpoint.streamTimeoutSec, DEFAULT_TIMEOUTS.remoteSec) * 1000;
  // Monet Local is local by construction — it is this app's own server —
  // even when reached at another machine's address on the LAN, because what
  // is at the other end is still llama.cpp reading a prompt slowly.
  const local = endpoint.kind === "monet-local" || isLocalEndpoint(endpoint.baseURL);
  return (local ? cfg.localSec : cfg.remoteSec) * 1000;
}

/**
 * A signal that fires when the caller's does, or when the deadline passes.
 *
 * Returns the caller's own signal unchanged when there is no deadline, so
 * "no watchdog" costs nothing and adds no listener.
 */
export function withDeadline(
  signal: AbortSignal | undefined,
  ms: number,
): AbortSignal | undefined {
  if (!ms || ms <= 0) return signal;
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Turn whatever `fetch` threw into something a person can act on.
 *
 * `AbortSignal.timeout` rejects with a bare "The operation was aborted", which
 * in a log next to a background pass says nothing at all about which of the
 * two aborts it was — the user pressing Stop, or a model that never answered.
 */
export function asDeadlineError(
  err: unknown,
  ms: number,
  callerSignal?: AbortSignal,
): Error {
  const aborted =
    err instanceof DOMException &&
    (err.name === "AbortError" || err.name === "TimeoutError");
  if (aborted && !callerSignal?.aborted && ms > 0)
    return new Error(`No answer within ${Math.round(ms / 1000)}s`);
  return err instanceof Error ? err : new Error(String(err));
}
