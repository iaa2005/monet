/**
 * Test for MCP-backed services: spawning the server IS the test — it fails
 * loudly on a bad token. Imported lazily because mcp/manager statically imports
 * the registry (to learn which services supply servers); a static import here
 * would close that loop.
 */

import type { ProtocolResult } from "../types.js";
import type { ResolvedAccount } from "./types.js";

export function makeMcpTest(
  serviceId: string,
): (acct: ResolvedAccount) => Promise<ProtocolResult> {
  return async () => {
    const { ensureConnected, getConnectorServerStatus } = await import(
      "../../mcp/manager.js"
    );
    await ensureConnected();
    const s = getConnectorServerStatus(serviceId);
    if (!s) return { ok: false, text: "", error: "Server did not start." };
    return s.status === "connected"
      ? { ok: true, text: `Connected — ${s.toolCount} tool(s).` }
      : { ok: false, text: "", error: s.error ?? `Server is ${s.status}.` };
  };
}
