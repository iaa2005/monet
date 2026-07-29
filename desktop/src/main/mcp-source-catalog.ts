/**
 * Which MCP registries to search — curated in the community repo.
 *
 * The official registry was the only one, hardcoded. It is now one entry in
 * `mcp-sources.json`, so adding another is a JSON edit and a push rather than
 * an app release. Same mechanism as skill-sources.json, same repo.
 *
 * `format` is the load-bearing field. A registry's URL is not enough to query
 * it: the response schema has to be one the app can read. `mcp-registry-v0` is
 * the official registry's `/v0/servers` shape, which any self-hosted instance
 * of that project also speaks — so that one format already covers more than
 * one host. A registry with its own schema needs code, and until that code
 * exists listing it here would produce a source that fails on first search.
 * Entries with an unknown format are therefore dropped, not attempted.
 *
 * Nothing here is executed. A registry entry is a place to LOOK for servers;
 * the Directory still hands whatever it finds to the ordinary "Add connector"
 * form, where the user reads the command line and supplies their own secrets.
 */

import { fetchRetry } from "./net-fetch.js";

const CATALOG_URL =
  "https://raw.githubusercontent.com/iaa2005/monet-directory/main/mcp-sources.json";

const CACHE_MS = 30 * 60_000;

/** Response schemas the app can actually parse. */
export const KNOWN_FORMATS = ["mcp-registry-v0"] as const;
export type McpFormat = (typeof KNOWN_FORMATS)[number];

export interface McpSource {
  id: string;
  name: string;
  /** Full endpoint, e.g. https://registry.modelcontextprotocol.io/v0/servers */
  api: string;
  format: McpFormat;
  description?: string;
  homepage?: string;
}

/**
 * The registry every build knows without the network.
 *
 * The catalog is a convenience, not a dependency: if GitHub is unreachable, or
 * the file has not been written yet, MCP search must still work exactly as it
 * did when the URL was a constant in this codebase.
 */
export const OFFICIAL_MCP_SOURCE: McpSource = {
  id: "modelcontextprotocol",
  name: "MCP Registry",
  api: "https://registry.modelcontextprotocol.io/v0/servers",
  format: "mcp-registry-v0",
  homepage: "https://registry.modelcontextprotocol.io",
  description: "The official Model Context Protocol registry.",
};

let cache: { at: number; list: McpSource[] } | null = null;

export function parseMcpCatalog(raw: unknown): McpSource[] {
  if (!Array.isArray(raw)) return [];
  const out: McpSource[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const e = r as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : "";
    const api = typeof e.api === "string" ? e.api : "";
    const format = typeof e.format === "string" ? e.format : "";
    if (!id) continue;
    // https only: this is a list of endpoints the app queries and whose
    // answers become command lines put in front of the user.
    if (!/^https:\/\//.test(api)) continue;
    if (!(KNOWN_FORMATS as readonly string[]).includes(format)) continue;
    out.push({
      id,
      name: typeof e.name === "string" && e.name ? e.name : id,
      api,
      format: format as McpFormat,
      description: typeof e.description === "string" ? e.description : undefined,
      homepage: typeof e.homepage === "string" ? e.homepage : undefined,
    });
  }
  const seen = new Set<string>();
  return out.filter((s) => !seen.has(s.id) && seen.add(s.id));
}

/**
 * The registries to search. Always includes the official one — a catalog that
 * omitted it, or failed to load, must not silently turn MCP search off.
 */
export async function mcpSources(force = false): Promise<McpSource[]> {
  let list: McpSource[] = [];
  if (!force && cache && Date.now() - cache.at < CACHE_MS) list = cache.list;
  else {
    try {
      const res = await fetchRetry(CATALOG_URL, {
        headers: { "User-Agent": "monet-desktop" },
      });
      if (!res.ok) throw new Error(String(res.status));
      list = parseMcpCatalog(await res.json());
      cache = { at: Date.now(), list };
    } catch {
      list = cache?.list ?? [];
    }
  }
  return list.some((s) => s.api === OFFICIAL_MCP_SOURCE.api)
    ? list
    : [OFFICIAL_MCP_SOURCE, ...list];
}
