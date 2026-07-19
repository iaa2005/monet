/**
 * Store manifests — connectors installed WITHOUT an app update.
 *
 * A store connector is DATA, never code: a manifest names endpoints and an
 * auth form, and the capabilities are built from the same protocol factories
 * the builtin services use (IMAP/SMTP, WebDAV, CalDAV/CardDAV, local MCP,
 * remote MCP with OAuth 2.1). That is the whole security model — installing
 * one cannot execute arbitrary JS. The residual risks are (a) a manifest
 * pointing a login form at an attacker's server, mitigated by https-only
 * endpoints that the install UI shows the user before confirming, and (b)
 * local MCP servers, which DO run code — so `command` is allowlisted to
 * package runners and the exact command line is shown at install time.
 *
 * Remote MCP (OAuth 2.1) connectors use the MCP SDK's auth() flow: discovery
 * (RFC 9728), dynamic client registration (RFC 7591), PKCE, and token
 * exchange — all protocol-driven, no hardcoded endpoints. The auth kind is
 * `oauth-mcp`; the user signs in via the browser, tokens are encrypted.
 */

import { makeMailOps } from "../lib/protocols/mail.js";
import { makeWebdavOps } from "../lib/protocols/webdav.js";
import { makeCaldavOps, makeCarddavOps } from "../lib/protocols/dav.js";
import { makeMcpTest } from "./mcp-test.js";
import type { AuthField, ConnectorService, SetupStep } from "./types.js";

export const MANIFEST_SCHEMA = 1;

/** Runners that resolve and run a published package. Anything else (bash,
 * cmd, a raw binary path) is refused — an MCP entry is already code execution,
 * the allowlist keeps it to auditable package names. */
export const MCP_COMMAND_ALLOWLIST = new Set(["npx", "uvx"]);

export interface ConnectorManifest {
  schema: number;
  /** Stable id — becomes the on-disk service id. Must not collide with a
   * builtin service. */
  id: string;
  name: string;
  /** Human-friendly name for Settings ("Google Gmail"). Falls back to `name`. */
  displayName?: string;
  company: string;
  description: string;
  /** Bump to ship an update; the store compares against the installed copy. */
  version: string;
  auth:
    | { kind: "password"; fields: AuthField[] }
    | { kind: "token"; field: AuthField }
    | { kind: "oauth-mcp" },
  credUrl?: string,
  credLabel?: string,
  note?: string,
  setupSteps?: SetupStep[],
  promptHint?: string,
  capabilities: {
    mail?: {
      imap: { host: string; port: number; secure: boolean };
      smtp: { host: string; port: number; secure: boolean };
      authHint?: string;
    };
    webdav?: { url: string; authHint?: string };
    caldav?: { url: string; principalTemplate?: string; authHint?: string };
    carddav?: { url: string; principalTemplate?: string; authHint?: string };
    mcp?:
      | { command: string; args: string[]; envKey: string }
      | { url: string; transport?: "http" | "sse" };
  };
}

/** Every network endpoint a manifest names — shown to the user pre-install. */
export function manifestEndpoints(m: ConnectorManifest): string[] {
  const out: string[] = [];
  const c = m.capabilities;
  if (c.mail) {
    out.push(`imaps://${c.mail.imap.host}:${c.mail.imap.port}`);
    out.push(`smtps://${c.mail.smtp.host}:${c.mail.smtp.port}`);
  }
  if (c.webdav) out.push(c.webdav.url);
  if (c.caldav) out.push(c.caldav.url);
  if (c.carddav) out.push(c.carddav.url);
  if (c.mcp) {
    if ("command" in c.mcp) {
      out.push(`run: ${c.mcp.command} ${c.mcp.args.join(" ")}`);
    } else {
      out.push(c.mcp.url);
    }
  }
  return out;
}

function bad(msg: string): never {
  throw new Error(`Invalid connector manifest: ${msg}`);
}

function checkHost(h: { host: string; port: number; secure: boolean }, what: string): void {
  if (!h.host || /[\s/@]/.test(h.host)) bad(`${what} host "${h.host}" is not a hostname`);
  if (!Number.isInteger(h.port) || h.port < 1 || h.port > 65535)
    bad(`${what} port ${h.port}`);
  if (h.secure !== true) bad(`${what} must use TLS (secure: true)`);
}

function checkHttps(url: string, what: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    bad(`${what} url "${url}" is not a URL`);
  }
  if (u.protocol !== "https:") bad(`${what} must be https`);
  if (u.username || u.password) bad(`${what} must not embed credentials`);
}

function checkField(f: AuthField, where: string): void {
  if (!f?.key || typeof f.key !== "string") bad(`${where}: field needs a key`);
  if (!f.label) bad(`${where}: field "${f.key}" needs a label`);
}

/**
 * Validate a manifest and build the ConnectorService it describes.
 * `builtinIds` protects the namespace: a store entry cannot shadow a builtin.
 */
export function manifestToService(
  m: ConnectorManifest,
  opts: { builtinIds: Set<string>; iconSvg?: string },
): ConnectorService {
  if (m.schema !== MANIFEST_SCHEMA)
    bad(`schema ${m.schema} (this app speaks ${MANIFEST_SCHEMA})`);
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(m.id)) bad(`id "${m.id}"`);
  if (opts.builtinIds.has(m.id)) bad(`id "${m.id}" collides with a builtin service`);
  if (!m.name || !m.description) bad("name and description are required");
  if (typeof m.company !== "string") bad("company must be a string ('' for none)");
  if (!m.version) bad("version is required");

  if (m.auth.kind === "password") {
    if (!m.auth.fields?.length) bad("auth.password needs fields");
    for (const f of m.auth.fields) checkField(f, "auth");
  } else if (m.auth.kind === "token") {
    checkField(m.auth.field, "auth");
  } else if (m.auth.kind !== "oauth-mcp") {
    bad(`auth kind "${(m.auth as { kind: string }).kind}" (manifests speak password/token/oauth-mcp only)`);
  }

  const c = m.capabilities ?? {};
  const service: ConnectorService = {
    id: m.id,
    name: m.name,
    displayName: m.displayName,
    company: m.company,
    description: m.description,
    iconSvg: opts.iconSvg?.includes("<svg") ? opts.iconSvg : undefined,
    auth: m.auth,
    credUrl: m.credUrl,
    credLabel: m.credLabel,
    note: m.note,
    setupSteps: m.setupSteps,
    capabilities: {},
    promptHint: m.promptHint,
    // Replaced below once the first capability exists.
    test: async () => ({
      ok: false,
      text: "",
      error: "This connector declares no capabilities.",
    }),
  };

  if (c.mail) {
    checkHost(c.mail.imap, "imap");
    checkHost(c.mail.smtp, "smtp");
    const ops = makeMailOps({
      imap: c.mail.imap,
      smtp: c.mail.smtp,
      authHint: c.mail.authHint,
    });
    service.capabilities.mail = ops;
    service.test = (acct) => ops.folders(acct);
  }
  if (c.webdav) {
    checkHttps(c.webdav.url, "webdav");
    const ops = makeWebdavOps(c.webdav);
    service.capabilities.files = ops;
    if (!c.mail) service.test = (acct) => ops.list(acct, { path: "/" });
  }
  if (c.caldav) {
    checkHttps(c.caldav.url, "caldav");
    const ops = makeCaldavOps(c.caldav);
    service.capabilities.calendar = ops;
    if (!c.mail && !c.webdav) service.test = (acct) => ops.calendars(acct);
  }
  if (c.carddav) {
    checkHttps(c.carddav.url, "carddav");
    const ops = makeCarddavOps(c.carddav);
    service.capabilities.contacts = ops;
    if (!c.mail && !c.webdav && !c.caldav)
      service.test = (acct) => ops.list(acct, { limit: 1 });
  }
  if (c.mcp) {
    if ("command" in c.mcp) {
      // Local MCP (stdio): npx/uvx with a token injected into env.
      if (!MCP_COMMAND_ALLOWLIST.has(c.mcp.command))
        bad(
          `mcp.command "${c.mcp.command}" — allowed: ${[...MCP_COMMAND_ALLOWLIST].join(", ")}`,
        );
      if (!Array.isArray(c.mcp.args) || c.mcp.args.some((a) => typeof a !== "string"))
        bad("mcp.args must be strings");
      if (!c.mcp.envKey) bad("mcp.envKey is required");
      service.capabilities.mcp = c.mcp;
    } else {
      // Remote MCP (OAuth 2.1): https URL, transport http or sse.
      if (!c.mcp.url) bad("mcp.url is required for remote MCP");
      checkHttps(c.mcp.url, "mcp.url");
      const transport = c.mcp.transport ?? "http";
      if (transport !== "http" && transport !== "sse")
        bad(`mcp.transport "${transport}" (allowed: http, sse)`);
      service.capabilities.mcp = { url: c.mcp.url, transport };
    }
    if (Object.keys(service.capabilities).length === 1)
      service.test = makeMcpTest(m.id);
  }

  if (Object.keys(service.capabilities).length === 0)
    bad("no capabilities declared");
  return service;
}
