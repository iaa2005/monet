/**
 * Sentry — unavailable until app-side OAuth for remote MCP exists. Probed:
 * mcp.sentry.dev/mcp answers a pasted token with 401 invalid_token +
 * WWW-Authenticate: Bearer realm="OAuth".
 */

import icon from "./icon.svg?raw";
import type { ConnectorService } from "../types.js";

const REASON =
  "Sentry's MCP server signs you in with your account (OAuth) rather than a token — it answers a pasted token with 401. This app doesn't do that OAuth sign-in flow yet, so Sentry can't be connected from here.";

export const Sentry: ConnectorService = {
  id: "sentry",
  name: "Sentry",
  company: "Developer tools",
  description: "Errors and issue details.",
  iconSvg: icon,
  auth: { kind: "unavailable", reason: REASON },
  credUrl: "https://docs.sentry.io/product/sentry-mcp/",
  credLabel: "Sentry MCP docs",
  capabilities: {},
  test: async () => ({ ok: false, text: "", error: REASON }),
};
