/**
 * The deferred-tool announcement.
 *
 * Reported live: a user with a connected Dropbox connector asked to upload a
 * file, and the model answered that "the Dropbox connector is only available
 * for routines" — a restriction that exists nowhere in this codebase.
 *
 * It was not confused about the file. ToolSearch was enabled, so all 20 Dropbox
 * MCP tools were held out of the standing schema, and nothing told the model
 * they existed. From inside the turn, a deferred capability and an absent one
 * are indistinguishable, so it explained an absence it had no reason to doubt.
 *
 * These checks pin the announcement's content: names must actually appear (a
 * server summary would not let the model call `select:`), the wording must
 * point at ToolSearch, and it must never leak a tool the run would refuse to
 * load — a name the model can see but not use is a worse failure than silence.
 */

import { readFileSync } from "fs";
import {
  SAMPLE_AFTER,
  renderDeferredDirective,
  type DeferredTool,
} from "../src/main/agent/deferred-inventory";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const tool = (server: string, name: string): DeferredTool => ({
  serverName: server,
  fullName: `mcp__${server}__${name}`,
});

const plain = (s: string): string => s;
const labelled = (s: string): string =>
  ({ dropbox: "Dropbox", alphaxiv: "alphaXiv" })[s] ?? s;

// ── 1. The reported case ──────────────────────────────────────────────
{
  const dropbox = ["upload", "download", "list_folder", "search", "share"].map((n) =>
    tool("dropbox", n),
  );
  const text = renderDeferredDirective(dropbox, labelled);

  check("something is announced at all", text.length > 0);
  check(
    "the server is named in a way the user would recognise",
    text.includes("Dropbox"),
    JSON.stringify(text.slice(0, 60)),
  );
  check(
    "the exact tool name is present, so select: can be typed",
    text.includes("mcp__dropbox__upload"),
  );
  check("ToolSearch is named as the way to load it", text.includes("ToolSearch"));
  check(
    "and the select: form is spelled out",
    text.includes("select:"),
    "keywords alone make the model guess",
  );
  // The specific failure being guarded: the model explaining a capability away.
  // Normalised: the directive is line-wrapped, so a phrase can straddle a break.
  const flat = text.replace(/\s+/g, " ");
  check(
    "it is told not to claim the capability is missing",
    /never tell the user a capability is missing/i.test(flat) &&
      /never invent a reason why it might be/i.test(flat),
    JSON.stringify(flat.slice(-160)),
  );
}

// ── 2. Nothing deferred ⇒ nothing said ────────────────────────────────
{
  check("an empty list produces no directive", renderDeferredDirective([], plain) === "");
}

// ── 3. Several servers stay separable ─────────────────────────────────
{
  const text = renderDeferredDirective(
    [tool("dropbox", "upload"), tool("alphaxiv", "search"), tool("dropbox", "search")],
    labelled,
  );
  const lines = text.split("\n").filter((l) => l.startsWith("- "));
  check("one line per server", lines.length === 2, JSON.stringify(lines));
  check(
    "a server's tools are grouped together, not scattered",
    lines[0]!.includes("mcp__dropbox__upload") && lines[0]!.includes("mcp__dropbox__search"),
    JSON.stringify(lines[0]),
  );
  check("the other server keeps its own line", lines[1]!.includes("alphaxiv"), JSON.stringify(lines[1]));
}

// ── 4. A big server is sampled, not dumped ────────────────────────────
{
  const many = Array.from({ length: 40 }, (_, i) => tool("big", `tool_${i}`));
  const text = renderDeferredDirective(many, plain);
  const listed = (text.match(/mcp__big__/g) ?? []).length;
  check("a huge server is truncated", listed === SAMPLE_AFTER, `${listed} listed of 40`);
  check(
    "and says how many it left out",
    text.includes(`and ${40 - SAMPLE_AFTER} more`),
    JSON.stringify(text.slice(-200)),
  );
  // Truncating silently would leave the model believing it had seen everything.
  check("the count is not silently dropped", /\d+ more/.test(text));
}
{
  const exact = Array.from({ length: SAMPLE_AFTER }, (_, i) => tool("edge", `t${i}`));
  const listed = (renderDeferredDirective(exact, plain).match(/mcp__edge__/g) ?? []).length;
  check("exactly at the cap, nothing is truncated", listed === SAMPLE_AFTER, listed);
  check(
    "and no bogus 'more' is claimed",
    !/more/.test(renderDeferredDirective(exact, plain)),
  );
}

// ── 5. A server with no friendly label still reads sanely ─────────────
{
  const text = renderDeferredDirective([tool("some-server", "do_thing")], plain);
  check(
    "an unlabelled server is not printed as 'x (x)'",
    !text.includes("some-server (some-server)"),
    JSON.stringify(text.split("\n").find((l) => l.startsWith("- "))),
  );
  check("but is still identified", text.includes("some-server"));
}

// ── 6. Home must be able to REACH what it defers ──────────────────────
{
  // The deeper half of the same bug, and the reason the announcement alone
  // would not have fixed it: vendor-tools deferred MCP tools in EVERY space,
  // while ToolSearch — the only way to undefer them — was gated Code-only
  // (`space !== "home"`). In Home a connector's tools were therefore held back
  // with nothing left that could reveal them: permanently unreachable, which is
  // exactly the state the reporting user was in.
  //
  // Read as source, because the invariant is the RELATIONSHIP between two
  // gates in one file; importing it would drag the whole vendor toolset in.
  const src = readFileSync("src/main/agent/vendor-tools.ts", "utf8");

  const gate = /if \(name === "ToolSearch"\)\s*return([^;]+);/.exec(src)?.[1] ?? "";
  check("the ToolSearch gate is still found", gate.length > 0, JSON.stringify(gate));
  check(
    "ToolSearch is no longer Code-only",
    !/space\s*!==\s*"home"/.test(gate),
    JSON.stringify(gate.trim()),
  );
  check(
    "it still requires the feature and a server",
    /getToolSearchConfig\(\)\.enabled/.test(gate) && /hasMcpServers\(\)/.test(gate),
    JSON.stringify(gate.trim()),
  );

  // And the catalog it searches must respect Home's own restriction, or it
  // would report loading a tool the tool list then refuses to advertise.
  const cat = readFileSync("src/main/agent/tool-search-tool.ts", "utf8");
  check(
    "the searchable catalog is space-filtered",
    /space === "home" \? connectorServerNames\(\)/.test(cat),
  );
  check("and the tool passes its space in", /deferredCatalog\(space\)/.test(cat));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL DEFERRED-INVENTORY CHECKS PASSED");
process.exit(failures ? 1 : 0);
