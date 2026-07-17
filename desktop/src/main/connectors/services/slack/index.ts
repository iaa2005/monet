/**
 * Slack — the reference MCP server (@modelcontextprotocol/server-slack)
 * spawned locally with a bot token.
 */

import icon from "./icon.svg?raw";
import { makeMcpTest } from "../mcp-test.js";
import type { ConnectorService } from "../types.js";

export const Slack: ConnectorService = {
  id: "slack",
  name: "Slack",
  company: "Developer tools",
  description: "Post and read channel messages via Slack's MCP server.",
  iconSvg: icon,
  auth: {
    kind: "token",
    field: {
      key: "password",
      label: "Bot token (xoxb-…)",
      secret: true,
      mono: true,
    },
  },
  credUrl: "https://api.slack.com/apps",
  credLabel: "Create app",
  note: "Create an app → OAuth & Permissions → add bot scopes → install to workspace, then copy the Bot User OAuth Token.",
  capabilities: {
    mcp: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      envKey: "SLACK_BOT_TOKEN",
    },
  },
  test: makeMcpTest("slack"),
};
