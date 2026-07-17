/**
 * Notion — the official MCP server (@notionhq/notion-mcp-server) spawned
 * locally with an internal integration token. The remote mcp.notion.com is
 * OAuth-only and answers a pasted token with 401, so it is deliberately not
 * used. The token authenticates fine but sees NOTHING until pages are shared
 * with the integration — that's Notion's model, not a bug.
 */

import icon from "./icon.svg?raw";
import { makeMcpTest } from "../mcp-test.js";
import type { ConnectorService } from "../types.js";

export const Notion: ConnectorService = {
  id: "notion",
  name: "Notion",
  company: "Developer tools",
  description: "Pages and databases via Notion's MCP server.",
  iconSvg: icon,
  auth: {
    kind: "token",
    field: {
      key: "password",
      label: "Internal integration token (ntn_…)",
      secret: true,
      mono: true,
    },
  },
  credUrl: "https://app.notion.com/developers/tokens",
  credLabel: "Get token",
  note: "After connecting, open each page or database in Notion → ••• → Connections → add your integration. Without that it authenticates fine but sees nothing — search returns empty, and pages can't be created at the workspace root at all.",
  capabilities: {
    mcp: {
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      envKey: "NOTION_TOKEN",
    },
  },
  test: makeMcpTest("notion"),
};
