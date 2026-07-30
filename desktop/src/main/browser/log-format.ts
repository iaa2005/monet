/**
 * Turning CDP events into log lines, and log lines into an answer.
 *
 * Dependency-free, because this is the part that breaks. The event payloads
 * are a protocol we do not control: a console argument arrives as `value` or
 * as `description` depending on its type, network failures show up in TWO
 * domains (and would be counted twice), and an iframe navigating looks exactly
 * like the page navigating unless you check for a parent frame.
 *
 * Lines are plain text rather than JSON: the model greps this.
 */

export type LogKind = "console" | "network";

export type LogOutcome =
  | { kind: LogKind; line: string; isError: boolean }
  /** The main frame navigated — counters for the old page no longer apply. */
  | { reset: true }
  | null;

/** hh:mm:ss.mmm — the only part of a timestamp worth the width. */
export function stampOf(d: Date): string {
  return d.toISOString().slice(11, 23);
}

/** One CDP value, as short readable text. */
function argText(arg: unknown): string {
  const a = arg as { value?: unknown; description?: string };
  // `description` first: for objects and errors it is the useful rendering,
  // and `value` is absent. For primitives it is the other way round.
  if (a?.description) return a.description;
  if (a?.value !== undefined)
    return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
  return "";
}

const bytes = (n: number): string =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : n >= 1024
      ? `${Math.round(n / 1024)} kB`
      : `${n} B`;

const clip = (s: string, n = 2000): string => s.slice(0, n);

/**
 * One CDP event → one log line, or nothing.
 *
 * `inFlight` maps requestId to "GET https://…" and is MUTATED here: a failed
 * request carries no URL of its own, so the only way to name what failed is to
 * have remembered it when it was sent.
 */
export function formatEvent(
  method: string,
  params: Record<string, unknown>,
  inFlight: Map<string, string>,
  stamp: string,
): LogOutcome {
  switch (method) {
    case "Runtime.consoleAPICalled": {
      const p = params as { type?: string; args?: unknown[] };
      const level = p.type === "warning" ? "warn" : (p.type ?? "log");
      const text = clip((p.args ?? []).map(argText).join(" "));
      return {
        kind: "console",
        line: `${stamp} ${level.padEnd(5)} ${text}`,
        isError: level === "error",
      };
    }

    case "Runtime.exceptionThrown": {
      const p = params as {
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string };
          url?: string;
          lineNumber?: number;
        };
      };
      const d = p.exceptionDetails ?? {};
      // CDP counts lines from 0; every editor counts from 1.
      const where = d.url ? ` (${d.url}:${(d.lineNumber ?? 0) + 1})` : "";
      return {
        kind: "console",
        line: `${stamp} error ${clip(d.exception?.description ?? d.text ?? "Uncaught")}${where}`,
        isError: true,
      };
    }

    case "Log.entryAdded": {
      const p = params as {
        entry?: { level?: string; text?: string; url?: string; source?: string };
      };
      const e = p.entry ?? {};
      // Network failures are reported here as well as by the Network domain.
      // Keeping both would double every failed request in the error count.
      if (e.source === "network") return null;
      const level = e.level === "warning" ? "warn" : (e.level ?? "log");
      return {
        kind: "console",
        line: `${stamp} ${level.padEnd(5)} ${clip(e.text ?? "")}${e.url ? ` (${e.url})` : ""}`,
        isError: level === "error",
      };
    }

    case "Network.requestWillBeSent": {
      const p = params as {
        requestId?: string;
        request?: { method?: string; url?: string };
      };
      if (p.requestId && p.request?.url)
        inFlight.set(p.requestId, `${p.request.method ?? "GET"} ${p.request.url}`);
      return null;
    }

    case "Network.responseReceived": {
      const p = params as {
        requestId?: string;
        response?: {
          url?: string;
          status?: number;
          mimeType?: string;
          encodedDataLength?: number;
        };
        type?: string;
      };
      const r = p.response ?? {};
      const status = r.status ?? 0;
      const label = p.requestId ? inFlight.get(p.requestId) : undefined;
      if (p.requestId) inFlight.delete(p.requestId);
      const size = r.encodedDataLength ? `, ${bytes(r.encodedDataLength)}` : "";
      return {
        kind: "network",
        line: `${stamp} ${status} ${label ?? `GET ${r.url ?? ""}`} (${
          p.type ?? r.mimeType ?? "?"
        }${size})`,
        isError: status >= 400,
      };
    }

    case "Network.loadingFailed": {
      const p = params as {
        requestId?: string;
        errorText?: string;
        canceled?: boolean;
      };
      const label = p.requestId ? inFlight.get(p.requestId) : undefined;
      if (p.requestId) inFlight.delete(p.requestId);
      // A cancelled request is usually the page itself navigating away. It is
      // not a failure, and reporting it as one sends the model hunting.
      if (p.canceled) return null;
      return {
        kind: "network",
        line: `${stamp} FAILED ${label ?? "request"} — ${p.errorText ?? "unknown"}`,
        isError: true,
      };
    }

    case "Page.frameNavigated": {
      const p = params as { frame?: { parentId?: string } };
      // An iframe navigating is not a new page. Resetting on it would clear
      // the error count for the page you actually loaded.
      return p.frame?.parentId ? null : { reset: true };
    }

    default:
      return null;
  }
}

/** Lines that count as errors, in either log. */
const ERROR_LINE = / error | FAILED | [45]\d\d /;
const WARN_LINE = / (warn|error) | FAILED | [45]\d\d /;

export interface FilterOpts {
  grep?: string;
  level?: "error" | "warn";
  /** How many to keep. The LAST n, because a fresh break is at the end. */
  limit?: number;
}

export interface Filtered {
  lines: string[];
  matched: number;
}

export function filterLines(all: string[], opts: FilterOpts = {}): Filtered {
  let hits = all;

  if (opts.level === "error") hits = hits.filter((l) => ERROR_LINE.test(` ${l} `));
  else if (opts.level === "warn") hits = hits.filter((l) => WARN_LINE.test(` ${l} `));

  if (opts.grep) {
    let re: RegExp;
    try {
      re = new RegExp(opts.grep, "i");
    } catch {
      // Not valid regex. A model that meant a literal `?` should get the lines
      // containing it, not an error about quantifiers.
      re = new RegExp(opts.grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    hits = hits.filter((l) => re.test(l));
  }

  return { lines: hits.slice(-(opts.limit ?? 100)), matched: hits.length };
}
