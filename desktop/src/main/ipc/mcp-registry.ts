/**
 * MCP registry IPC — search the official Model Context Protocol registry.
 *
 * Registries come from mcp-source-catalog.ts, so more can be added without an
 * app release; the official one is always among them. They all speak the
 * `/v0/servers` schema — public, no auth, `version=latest` collapsing the
 * one-row-per-release listing. Verified against the live API, not inferred
 * from docs.
 *
 * We only ever RETURN a suggested config here. Nothing is installed from this
 * module: the Directory hands the suggestion to the normal "Add connector"
 * form, so the user reads the exact command line (or URL) and fills in their
 * own secrets before anything is written or launched.
 */

import { ipcMain } from "electron";
import {
  mcpSources,
  OFFICIAL_MCP_SOURCE,
  type McpSource,
} from "../mcp-source-catalog.js";

const UA = { "User-Agent": "monet-desktop" };

/** An env var or header the user must supply before the server will run. */
export interface RegistryVar {
  name: string;
  description?: string;
  required: boolean;
  secret: boolean;
  /** Pre-filled value from the registry — may contain {placeholders}. */
  value?: string;
}

export interface RegistryServer {
  /** Reverse-DNS registry name, unique: "io.github.owner/server". */
  id: string;
  /** Last segment — what the card shows big. */
  name: string;
  /** Everything before the slash — the publisher. */
  namespace: string;
  description: string;
  version: string;
  repoUrl?: string;
  transport: "stdio" | "http" | "sse";
  /** How the app would run it. `command` for stdio, `url` for remote. */
  command?: string;
  args?: string[];
  url?: string;
  /** Env vars (stdio) or headers (remote) the user must fill in. */
  vars: RegistryVar[];
  /** `<slots>` left in `args` for the user to replace before saving. */
  placeholders?: string[];
  /** Set when the entry lists neither a package nor a remote we can run. */
  unsupported?: string;
  /** Which registry it came from — several can be configured. */
  source?: string;
}

interface ApiArgument {
  type?: "positional" | "named";
  name?: string;
  value?: string;
  default?: string;
  valueHint?: string;
  isRequired?: boolean;
  isRepeated?: boolean;
}

interface ApiVar {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  value?: string;
  default?: string;
}

interface ApiPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type?: string };
  runtimeArguments?: ApiArgument[];
  packageArguments?: ApiArgument[];
  environmentVariables?: ApiVar[];
}

interface ApiRemote {
  type?: string;
  url?: string;
  headers?: ApiVar[];
}

interface ApiServer {
  name?: string;
  description?: string;
  version?: string;
  repository?: { url?: string };
  packages?: ApiPackage[];
  remotes?: ApiRemote[];
}

/** The launcher for a package registry. `runtimeHint` is publisher-provided
 * and often wrong (pypi entries claiming "python"), so the registry type wins
 * except where the hint names a launcher we actually know. */
const LAUNCHERS: Record<string, string> = {
  npm: "npx",
  pypi: "uvx",
  nuget: "dnx",
  oci: "docker",
};
const KNOWN_HINTS = new Set(["npx", "uvx", "bunx", "pnpx", "dnx", "docker"]);

/**
 * One argument → command-line tokens.
 *
 * A required argument frequently carries no value: the registry is describing
 * a slot ("allowed-directories", valueHint "directory") the operator has to
 * fill. Emitting the flag alone would look like a finished command and fail at
 * launch; dropping it silently loses a required argument. Both are worse than
 * an obvious `<placeholder>` the user cannot miss in the pre-filled form.
 */
function argToTokens(a: ApiArgument, placeholders: string[]): string[] {
  const value = a.value ?? a.default;
  const slot = (): string => {
    const p = `<${a.valueHint ?? a.name ?? "value"}>`;
    placeholders.push(p);
    return p;
  };
  if (a.type === "named" && a.name) {
    if (value) return [a.name, value];
    return a.isRequired ? [a.name, slot()] : [];
  }
  if (value) return [value];
  return a.isRequired ? [slot()] : [];
}

function toVar(v: ApiVar): RegistryVar {
  return {
    name: v.name,
    description: v.description,
    required: v.isRequired === true,
    secret: v.isSecret === true,
    value: v.value ?? v.default,
  };
}

function fromPackage(p: ApiPackage): Partial<RegistryServer> | null {
  const type = p.registryType ?? "";
  const launcher =
    (p.runtimeHint && KNOWN_HINTS.has(p.runtimeHint) ? p.runtimeHint : null) ??
    LAUNCHERS[type];
  if (!launcher || !p.identifier) return null;

  const placeholders: string[] = [];
  const runtimeArgs = (p.runtimeArguments ?? []).flatMap((a) =>
    argToTokens(a, placeholders),
  );
  const pkgArgs = (p.packageArguments ?? []).flatMap((a) =>
    argToTokens(a, placeholders),
  );

  let args: string[];
  if (launcher === "docker") {
    // Env vars have to be forwarded explicitly into the container.
    const envFlags = (p.environmentVariables ?? []).flatMap((v) => [
      "-e",
      v.name,
    ]);
    args = [
      "run",
      "-i",
      "--rm",
      ...envFlags,
      ...runtimeArgs,
      p.version ? `${p.identifier}:${p.version}` : p.identifier,
      ...pkgArgs,
    ];
  } else {
    const yes = launcher === "npx" && !runtimeArgs.includes("-y") ? ["-y"] : [];
    const spec = p.version ? `${p.identifier}@${p.version}` : p.identifier;
    args = [...yes, ...runtimeArgs, spec, ...pkgArgs];
  }

  return {
    transport: "stdio",
    command: launcher,
    args,
    vars: (p.environmentVariables ?? []).map(toVar),
    placeholders,
  };
}

function fromRemote(r: ApiRemote): Partial<RegistryServer> | null {
  if (!r.url) return null;
  // The registry says "streamable-http"; our manager calls that "http".
  const transport = r.type === "sse" ? "sse" : "http";
  return {
    transport,
    url: r.url,
    vars: (r.headers ?? []).map(toVar),
  };
}

function normalize(s: ApiServer): RegistryServer | null {
  const id = s.name;
  if (!id) return null;
  const slash = id.lastIndexOf("/");
  const base: RegistryServer = {
    id,
    namespace: slash > 0 ? id.slice(0, slash) : "",
    name: slash > 0 ? id.slice(slash + 1) : id,
    description: (s.description ?? "").slice(0, 400),
    version: s.version ?? "",
    repoUrl: s.repository?.url,
    transport: "stdio",
    vars: [],
  };

  // Prefer a package (runs locally, no third-party proxy) over a remote.
  for (const p of s.packages ?? []) {
    const run = fromPackage(p);
    if (run) return { ...base, ...run };
  }
  for (const r of s.remotes ?? []) {
    const run = fromRemote(r);
    if (run) return { ...base, ...run };
  }
  return {
    ...base,
    unsupported: (s.packages ?? []).length
      ? `Published only as ${[...new Set((s.packages ?? []).map((p) => p.registryType))].join(", ")} — add it by hand.`
      : "No package or remote endpoint listed.",
  };
}

/** One registry, `mcp-registry-v0` schema. */
async function searchOne(
  src: McpSource,
  query: string,
  limit: number,
): Promise<RegistryServer[]> {
  const url = new URL(src.api);
  url.searchParams.set("version", "latest");
  url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 100)));
  if (query.trim()) url.searchParams.set("search", query.trim());

  const res = await fetch(url, {
    headers: { ...UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${src.name}: registry error ${res.status}`);
  const json = (await res.json()) as { servers?: { server?: ApiServer }[] };
  const out: RegistryServer[] = [];
  for (const row of json.servers ?? []) {
    const e = row.server ? normalize(row.server) : null;
    if (e) out.push({ ...e, source: src.id });
  }
  return out;
}

/**
 * Every configured registry, merged.
 *
 * One unreachable registry must not blank the list — the others are still
 * useful, and a search that returns nothing because a source the user has
 * never heard of is down is worse than a partial answer. Failures come back
 * alongside the results.
 *
 * De-duplication is by registry id, first source winning: `version=latest`
 * already repeats a name across a publisher's re-uploads, and two registries
 * mirroring the same server would repeat it again.
 */
async function search(
  query: string,
  limit: number,
): Promise<{ servers: RegistryServer[]; errors: string[] }> {
  const sources = await mcpSources();
  const results = await Promise.allSettled(
    sources.map((s) => searchOne(s, query, limit)),
  );
  const servers: RegistryServer[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      errors.push(
        `${sources[i]!.name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      );
      return;
    }
    for (const e of r.value) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      servers.push(e);
    }
  });
  return { servers, errors };
}

export function registerMcpRegistryIPC(): void {
  ipcMain.handle(
    "mcpregistry:search",
    async (
      _e,
      payload: { query?: string; limit?: number },
    ): Promise<{
      ok: boolean;
      servers?: RegistryServer[];
      errors?: string[];
      error?: string;
    }> => {
      try {
        const { servers, errors } = await search(
          payload?.query ?? "",
          payload?.limit ?? 60,
        );
        return { ok: true, servers, errors };
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : "Could not reach the MCP registry.",
        };
      }
    },
  );
}
