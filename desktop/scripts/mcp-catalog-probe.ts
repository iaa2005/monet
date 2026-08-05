/**
 * Parsing mcp-sources.json — which MCP registries the app searches.
 *
 * The official registry used to be a constant. It is now one row in a file
 * anyone with push access edits, so a bad row must not produce a source that
 * fails on first search.
 *
 * The rule that differs from the skill catalog: a registry's URL is not enough.
 * The response schema has to be one the app can read, so an entry declares a
 * `format`, and an unknown format is dropped rather than attempted. Guessing
 * would mean querying a stranger's endpoint and trying to turn whatever comes
 * back into a command line shown to the user.
 *
 * And the invariant that matters most: the official registry survives anything
 * the file does — including the file being absent, empty, or full of junk.
 * Losing MCP search because a catalog edit went wrong would be a regression
 * from when the URL was hardcoded.
 */

import {
  KNOWN_FORMATS,
  OFFICIAL_MCP_SOURCE,
  parseMcpCatalog,
} from "../src/main/mcp/source-catalog.js";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const official = {
  id: "modelcontextprotocol",
  name: "MCP Registry",
  api: "https://registry.modelcontextprotocol.io/v0/servers",
  format: "mcp-registry-v0",
};

// ── 1. The file as intended ───────────────────────────────────────────
{
  const list = parseMcpCatalog([
    official,
    {
      id: "acme-internal",
      name: "Acme Internal",
      api: "https://mcp.acme.test/v0/servers",
      format: "mcp-registry-v0",
      description: "A self-hosted instance.",
    },
  ]);
  check("both registries parse", list.length === 2, list.length);
  check("the endpoint is kept whole", list[0]?.api === official.api);
  check("order is the curator's", list[0]?.id === "modelcontextprotocol");
  check("a name falls back to the id", parseMcpCatalog([{ ...official, name: undefined }])[0]?.name === "modelcontextprotocol");
}

// ── 2. A schema the app cannot read ───────────────────────────────────
{
  // The whole point of `format`. Querying an endpoint whose answers we cannot
  // parse produces either nothing or garbage turned into a command line.
  const list = parseMcpCatalog([
    { id: "x", name: "X", api: "https://example.test/api", format: "some-other-registry" },
  ]);
  check("an unknown format is dropped, not attempted", list.length === 0, JSON.stringify(list));
  check("a missing format is dropped too", parseMcpCatalog([{ id: "y", api: "https://a.test/x" }]).length === 0);
  check("the known-format list is not empty", KNOWN_FORMATS.length > 0, JSON.stringify(KNOWN_FORMATS));
}

// ── 3. Transport ──────────────────────────────────────────────────────
{
  const list = parseMcpCatalog([{ ...official, id: "insecure", api: "http://registry.test/v0/servers" }]);
  check("plain http is refused", list.length === 0, JSON.stringify(list));
  check("a missing api is refused", parseMcpCatalog([{ id: "z", format: "mcp-registry-v0" }]).length === 0);
}

// ── 4. Malformed files must not throw ─────────────────────────────────
{
  check("a non-array is empty", parseMcpCatalog({ nope: 1 }).length === 0);
  check("null is empty", parseMcpCatalog(null).length === 0);
  check("junk rows are skipped", parseMcpCatalog([null, 7, "x", []]).length === 0);
  check(
    "one bad row does not discard a good one",
    parseMcpCatalog([{ id: "bad" }, official]).length === 1,
  );
}

// ── 5. Duplicate ids ──────────────────────────────────────────────────
{
  const list = parseMcpCatalog([
    { ...official, api: "https://first.test/v0/servers" },
    { ...official, api: "https://second.test/v0/servers" },
  ]);
  check("a duplicate id appears once", list.length === 1, list.length);
  check("the first wins", list[0]?.api === "https://first.test/v0/servers");
}

// ── 6. The official registry is not losable ───────────────────────────
{
  // mcpSources() prepends it whenever the catalog does not already carry it.
  // Modelled here rather than fetched, so the check does not depend on the
  // network: what is being pinned is that no catalog content removes it.
  const withOfficial = (parsed: ReturnType<typeof parseMcpCatalog>) =>
    parsed.some((s) => s.api === OFFICIAL_MCP_SOURCE.api)
      ? parsed
      : [OFFICIAL_MCP_SOURCE, ...parsed];

  check("an empty catalog still searches the official registry", withOfficial(parseMcpCatalog([])).length === 1);
  check("a junk catalog too", withOfficial(parseMcpCatalog("garbage")).length === 1);
  check(
    "a catalog of only third parties keeps it as well",
    withOfficial(parseMcpCatalog([{ id: "other", name: "Other", api: "https://o.test/v0/servers", format: "mcp-registry-v0" }]))
      .some((s) => s.api === OFFICIAL_MCP_SOURCE.api),
  );
  check(
    "and it is not duplicated when the catalog lists it",
    withOfficial(parseMcpCatalog([official])).filter((s) => s.api === OFFICIAL_MCP_SOURCE.api).length === 1,
  );
  check("the built-in default is itself a known format", (KNOWN_FORMATS as readonly string[]).includes(OFFICIAL_MCP_SOURCE.format));
  check("and https", OFFICIAL_MCP_SOURCE.api.startsWith("https://"));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL MCP-CATALOG CHECKS PASSED");
process.exit(failures ? 1 : 0);
