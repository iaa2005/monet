/**
 * GitHub — the reference MCP server (@modelcontextprotocol/server-github)
 * spawned locally with a personal access token. GitHub's REMOTE MCP server
 * (api.githubcopilot.com) is Copilot-gated — that's the 402 — so the local one
 * is the path that works with a plain PAT.
 */

import icon from "./icon.svg?raw";
import { makeMcpTest } from "../mcp-test.js";
import type { ConnectorService } from "../types.js";

export const GitHub: ConnectorService = {
  id: "github",
  name: "GitHub",
  company: "GitHub",
  description: "Issues, pull requests, repositories via GitHub's MCP server.",
  iconSvg: icon,
  auth: {
    kind: "token",
    field: {
      key: "password",
      label: "Personal access token",
      secret: true,
      mono: true,
    },
  },
  credUrl: "https://github.com/settings/tokens",
  credLabel: "Get token",
  note: "Classic tokens work; give it repo scope. GitHub's remote MCP server needs a Copilot subscription, so this runs the local one with your token.",
  capabilities: {
    mcp: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      envKey: "GITHUB_PERSONAL_ACCESS_TOKEN",
    },
  },
  test: makeMcpTest("github"),
};
