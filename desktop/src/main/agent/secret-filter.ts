/**
 * Keep secrets out of search results.
 *
 * The vendor's Grep runs ripgrep with `--hidden` and excludes only VCS
 * directories, so `.env`, `id_rsa` and `*.pem` inside the workspace are
 * searchable and their CONTENT comes back in `output_mode: "content"`. Glob
 * lists them the same way. Nothing asked the user first.
 *
 * Kimi Code filters these unconditionally — its `include_ignored` flag lifts
 * the .gitignore filter but never the secret filter — and that is the rule
 * copied here: no input can turn this off.
 *
 * Two different mechanisms, because the two tools differ:
 *
 *  - **Grep** accepts a `glob` input that becomes `--glob` arguments, so the
 *    exclusions are appended there and ripgrep never opens the file. This
 *    matters: `head_limit` is applied to ripgrep's output, so post-filtering
 *    would let 250 `.env` hits fill the budget and report "no matches" while
 *    real ones sat past the cut.
 *  - **Glob** takes a strict `{pattern, path}` input with no exclusion field,
 *    so its `filenames` are filtered on the way out. Safe here — Glob returns
 *    names only, never content.
 *
 * This hides files from SEARCH. It is deliberately not a read gate: asking the
 * agent to open `.env` after you told it to is a legitimate request, and that
 * decision belongs to the permission layer, not to grep.
 */

import type { Tool } from "../engine/Tool.js";

/**
 * Files whose contents are secrets often enough that searching them by
 * accident is the common case and searching them on purpose is the rare one.
 *
 * Patterns are ripgrep globs, already negated. `**` prefixes make them match
 * at any depth — ripgrep applies a bare `.env` only at the search root.
 */
export const SENSITIVE_GLOBS: readonly string[] = [
  // Environment files, including committed templates like `.env.example`.
  // Excluding the templates too is not the intent, it is a limitation: a
  // ripgrep glob cannot say "`.env.*` except `.env.example`", and the obvious
  // workaround — adding `**/.env.example` as a positive glob — silently turns
  // the whole set into an ALLOW-list and hides every other file in the repo.
  // Verified: with one positive glob added, a plain `app.ts` match disappeared.
  // Losing grep over placeholder files is the cheaper mistake, and Read and
  // Glob still show them.
  "!**/.env",
  "!**/.env.*",
  "!**/*.env",
  // SSH and PGP private keys.
  "!**/id_rsa",
  "!**/id_dsa",
  "!**/id_ecdsa",
  "!**/id_ed25519",
  "!**/*.pem",
  "!**/*.ppk",
  "!**/*.gpg",
  "!**/*.asc",
  // Certificate bundles and keystores.
  "!**/*.pfx",
  "!**/*.p12",
  "!**/*.jks",
  "!**/*.keystore",
  // Credential stores for common tooling.
  "!**/.netrc",
  "!**/.pgpass",
  "!**/.npmrc",
  "!**/.pypirc",
  "!**/credentials",
  "!**/.aws/credentials",
];

/**
 * The glob suffix appended to a Grep call.
 *
 * Negated patterns ONLY. ripgrep switches to allow-list semantics the moment
 * any positive glob is present, so a single one here would hide the entire
 * repository from every search.
 */
export const GREP_EXCLUSION_SUFFIX: string = SENSITIVE_GLOBS.join(" ");

const TEMPLATE_RE = /\.env\.(example|sample|template|dist)$/i;

/** Whether a path points at a file the search tools must not surface. */
export function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (TEMPLATE_RE.test(base)) return false;

  if (base === ".env" || base.startsWith(".env.") || base.endsWith(".env"))
    return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return true;
  if (/\.(pem|ppk|gpg|asc|pfx|p12|jks|keystore)$/i.test(base)) return true;
  if (
    base === ".netrc" ||
    base === ".pgpass" ||
    base === ".npmrc" ||
    base === ".pypirc" ||
    base === "credentials"
  )
    return true;
  return false;
}

/**
 * Grep with the secret exclusions appended to whatever `glob` the model asked
 * for. The vendor splits `glob` on whitespace then commas, so a space-joined
 * suffix lands as separate `--glob` arguments.
 */
export function grepWithSecretFilter(tool: Tool): Tool {
  const call = tool.call.bind(tool);
  return {
    ...tool,
    call: (args: unknown, ...rest: unknown[]) => {
      const input = (args ?? {}) as { glob?: string };
      const glob = input.glob?.trim();
      return (call as (...a: unknown[]) => unknown)(
        {
          ...input,
          glob: glob ? `${glob} ${GREP_EXCLUSION_SUFFIX}` : GREP_EXCLUSION_SUFFIX,
        },
        ...rest,
      );
    },
  } as Tool;
}

/** Glob with sensitive paths dropped from the returned `filenames`. */
export function globWithSecretFilter(tool: Tool): Tool {
  const call = tool.call.bind(tool);
  return {
    ...tool,
    call: async (...a: unknown[]) => {
      const result = (await (call as (...x: unknown[]) => Promise<unknown>)(
        ...a,
      )) as { data?: { filenames?: string[]; numFiles?: number } };
      const names = result?.data?.filenames;
      if (!Array.isArray(names)) return result;
      const kept = names.filter((n) => !isSensitivePath(n));
      if (kept.length === names.length) return result;
      return {
        ...result,
        data: { ...result.data, filenames: kept, numFiles: kept.length },
      };
    },
  } as Tool;
}
