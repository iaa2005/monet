/**
 * Linear — unavailable until app-side OAuth for remote MCP exists. Probed:
 * mcp.linear.app/mcp answers a pasted token with 401 invalid_token +
 * WWW-Authenticate: Bearer realm="OAuth". There is nothing to paste.
 */

import icon from "./icon.svg?raw";
import type { ConnectorService } from "../types.js";

const REASON =
  "Linear's MCP server signs you in with your account (OAuth) rather than a token — it answers a pasted token with 401. This app doesn't do that OAuth sign-in flow yet, so Linear can't be connected from here.";

export const Linear: ConnectorService = {
  id: "linear",
  name: "Linear",
  company: "Linear",
  description: "Issues, projects, triage.",
  iconSvg: icon,
  auth: { kind: "unavailable", reason: REASON },
  credUrl: "https://linear.app/docs/mcp",
  credLabel: "Linear MCP docs",
  capabilities: {},
  test: async () => ({ ok: false, text: "", error: REASON }),
};
