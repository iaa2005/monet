/**
 * Actually run it.
 *
 * The verification loop runs what the project declares — typecheck, lint —
 * and a green typecheck says only that the code is well-formed. It cannot
 * say that the page renders, that the button is wired to anything, or that
 * the request the page makes on load returns 200. That gap is where "it
 * compiles, ship it" lives, and it is most of what a user means when they
 * say the feature does not work.
 *
 * So this starts the project's own dev server, opens the page in a window
 * nobody sees, and watches: uncaught errors, failed requests, a page that
 * never loads, a body that stays empty. What it finds becomes the next
 * prompt, in the model's own terms — a stack trace it can act on rather
 * than "something is wrong".
 *
 * The server comes from what the project ALREADY declares (a `dev` script,
 * a `start` script, `.monet/servers.json`), never from the model, so the
 * harness starting a process stays bounded by what the project tells any
 * developer to run.
 *
 * The pure half lives here — which server, what counts as a problem, how
 * it reads. The window is in smoke-run.ts, because a probe cannot open one.
 */

/** How long to watch a loaded page before deciding it is fine. Long enough
 * for a first render and its first requests; short enough that nobody
 * notices the wait more than they notice a broken page. */
export const WATCH_MS = 4_000;

/** Errors past this are noise: the first few name the cause, the rest are
 * the same failure echoing through every component that depended on it. */
export const MAX_PROBLEMS = 6;

export interface SmokeProblem {
  kind: "console" | "request" | "load" | "empty";
  text: string;
}

export interface SmokeOutcome {
  status: "clean" | "problems" | "skipped";
  url?: string;
  problems: SmokeProblem[];
  /** Why nothing was run, for the log and the UI. */
  reason?: string;
}

/** A dev-server candidate as the servers store knows it. */
export interface ServerCandidate {
  id: string;
  name: string;
  command: string;
  port: number;
}

/**
 * Which server to smoke.
 *
 * The one whose name or command says "dev" first, then "start", then
 * whatever there is — the same order a developer would try. A project with
 * no server at all is not a failure; it is a project this check does not
 * apply to.
 */
export function pickServer(servers: ServerCandidate[]): ServerCandidate | null {
  if (servers.length === 0) return null;
  const score = (s: ServerCandidate): number => {
    const hay = `${s.name} ${s.command}`.toLowerCase();
    if (/\bdev\b/.test(hay)) return 0;
    if (/\bstart\b/.test(hay)) return 1;
    if (/\bserve\b|\bpreview\b/.test(hay)) return 2;
    return 3;
  };
  return [...servers].sort((a, b) => score(a) - score(b))[0] ?? null;
}

/**
 * Is this console line worth reporting?
 *
 * A dev server is a noisy place: HMR chatter, deprecation notices, the
 * React devtools advert, a favicon nobody added. Reporting those as
 * problems trains the user to switch the feature off, so the filter is
 * deliberately aggressive — a real uncaught error survives it, and the
 * point of this check is the real ones.
 */
const NOISE = [
  /download the react devtools/i,
  /\[vite\]/i,
  /\[hmr\]/i,
  /favicon\.ico/i,
  /deprecat/i,
  /devtools failed to load/i,
  /autofill\.enable/i,
  /source ?map/i,
];

export function isNoise(text: string): boolean {
  return NOISE.some((re) => re.test(text));
}

/** A network failure worth reporting — the page's own requests, not the
 * browser's housekeeping. */
export function requestProblem(url: string, status: number): string | null {
  if (status < 400) return null;
  if (/favicon\.ico$/i.test(url)) return null;
  // A dev server answers 404 for source maps it did not build. Not the bug.
  if (/\.map(\?|$)/i.test(url)) return null;
  return `${status} on ${url}`;
}

/** What the model is told when the page did not come up clean. */
export function smokePrompt(outcome: SmokeOutcome): string {
  return [
    `[The app was started and opened at ${outcome.url ?? "its dev server"}. It is not clean:]`,
    "",
    ...outcome.problems.map((p) => `- ${label(p.kind)}: ${p.text}`),
    "",
    "Find the cause and fix it. These are from the running app, not from a",
    "linter — the code compiles and still does this. If a problem is not",
    "actually yours to fix, say which and why in one line.",
  ].join("\n");
}

function label(kind: SmokeProblem["kind"]): string {
  switch (kind) {
    case "console":
      return "Uncaught in the page";
    case "request":
      return "Failed request";
    case "load":
      return "The page did not load";
    case "empty":
      return "The page loaded empty";
  }
}

/** One line for the chat, whatever happened. */
export function smokeSummary(outcome: SmokeOutcome): string {
  if (outcome.status === "clean")
    return `The app runs — ${outcome.url} loaded with nothing in the console`;
  if (outcome.status === "skipped")
    return `Did not run the app: ${outcome.reason ?? "no dev server"}`;
  const n = outcome.problems.length;
  return `The app came up with ${n} problem${n === 1 ? "" : "s"}`;
}

/** Fold what was collected into a verdict, noise removed and capped. */
export function judgeSmoke(
  url: string,
  raw: SmokeProblem[],
): SmokeOutcome {
  const problems: SmokeProblem[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (p.kind === "console" && isNoise(p.text)) continue;
    const key = `${p.kind}:${p.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push(p);
    if (problems.length >= MAX_PROBLEMS) break;
  }
  return {
    status: problems.length ? "problems" : "clean",
    url,
    problems,
  };
}
