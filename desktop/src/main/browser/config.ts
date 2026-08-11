/**
 * Browser config — the model can drive a browser only when the user opts in
 * (it is outward-facing, like the official app's "Browser Use" toggle).
 *
 * Three engines answer to the same tools:
 *   embedded — the <webview> in the app's Browser panel (default)
 *   external — a separate Chrome/Edge launched with its own profile
 *   bridge   — the user's OWN browser, through the Code Monet extension
 * The engine decides which transport the page operations talk to; everything
 * above the transport (refs, human-paced input, tools) is shared.
 *
 * The third exists because the first two start as strangers to every site: a
 * fresh profile is signed into nothing, and an embedded webview is what
 * Google's anti-phishing check refuses outright. The user's daily browser is
 * already signed in, so nothing has to be signed into twice. See bridge.ts.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";

/** Which browser the tools drive. */
export type BrowserEngine = "embedded" | "external" | "bridge";

/** How much the model may do without asking. See browser/origins.ts. */
export type BrowserApproval = "manual" | "allowlist" | "auto";

/** What survives between runs: nothing, one store per workspace, or one per chat. */
export type BrowserPersist = "none" | "shared" | "perChat";

export interface BrowserConfig {
  enabled: boolean;
  engine: BrowserEngine;
  approval: BrowserApproval;
  /** Origin patterns the model may act on without asking, e.g. https://*.acme.dev.
   * localhost is always allowed and is NOT stored here (see origins.ts). */
  allowedOrigins: string[];
  persistSessions: BrowserPersist;
  /** target=_blank opens a tab in our own strip instead of the OS browser. */
  openLinksInPanel: boolean;
}

const DEFAULT: BrowserConfig = {
  enabled: false,
  engine: "embedded",
  approval: "allowlist",
  allowedOrigins: [],
  persistSessions: "shared",
  openLinksInPanel: true,
};

function configPath(): string {
  return join(getDataDir(), "browser.json");
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

export function getBrowserConfig(): BrowserConfig {
  try {
    const p = configPath();
    if (!existsSync(p)) return { ...DEFAULT };
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<BrowserConfig>;
    return {
      enabled: !!raw.enabled,
      engine: oneOf(raw.engine, ["embedded", "external", "bridge"], DEFAULT.engine),
      approval: oneOf(raw.approval, ["manual", "allowlist", "auto"], DEFAULT.approval),
      allowedOrigins: Array.isArray(raw.allowedOrigins)
        ? raw.allowedOrigins.filter((o): o is string => typeof o === "string")
        : [],
      persistSessions: oneOf(
        raw.persistSessions,
        ["none", "shared", "perChat"],
        DEFAULT.persistSessions,
      ),
      openLinksInPanel: raw.openLinksInPanel !== false,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function setBrowserConfig(patch: Partial<BrowserConfig>): BrowserConfig {
  const next = { ...getBrowserConfig(), ...patch };
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
  return next;
}
