/**
 * Pure rules over an MCP server's config — no connections, no Electron.
 *
 * Separate from manager.ts so they can be exercised on their own: manager.ts
 * reaches the whole connector tree through its imports, and a test for "does
 * an empty allow-list mean nothing or everything?" should not need a browser
 * runtime to answer.
 */

export interface ToolFilterConfig {
  /** Allow-list. When present, only these tools are exposed. */
  enabledTools?: string[];
  /** Block-list, applied after the allow-list. */
  disabledTools?: string[];
}

export interface HeaderConfig {
  headers?: Record<string, string>;
  /** Name of an env var holding a bearer token, rather than the token. */
  bearerTokenEnvVar?: string;
}

/**
 * Apply a server's tool allow/block lists.
 *
 * Allow-list first, block-list after — so a config can say "only these five,
 * and actually not that one" without the two rules fighting.
 *
 * An empty `enabledTools: []` means exactly what it says: expose nothing.
 * Reading it as "unset" would quietly hand the model every tool the server
 * has, which is the opposite of the request.
 */
export function filterTools<T extends { name: string }>(
  tools: T[],
  config: ToolFilterConfig,
): T[] {
  let out = tools;
  if (config.enabledTools) {
    const allow = new Set(config.enabledTools);
    out = out.filter((t) => allow.has(t.name));
  }
  if (config.disabledTools?.length) {
    const deny = new Set(config.disabledTools);
    out = out.filter((t) => !deny.has(t.name));
  }
  return out;
}

/**
 * Request headers for a remote server, with the token read from the
 * environment when the config names a variable instead of carrying the value.
 * That keeps the credential out of mcp-servers.json, which is plain text and
 * ends up in backups and screen shares.
 *
 * An explicit `Authorization` header wins: someone who wrote one meant it.
 * A named variable that is not set produces NO header rather than the string
 * "Bearer undefined" — a real value a server will reject with a confusing
 * message, where an absent header gives an honest 401.
 */
export function resolveHeaders(
  config: HeaderConfig,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> | undefined {
  const headers = { ...(config.headers ?? {}) };
  const hasAuth = Object.keys(headers).some(
    (k) => k.toLowerCase() === "authorization",
  );
  if (config.bearerTokenEnvVar && !hasAuth) {
    const token = env[config.bearerTokenEnvVar]?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}
