/**
 * OAuth for hand-added remote MCP servers.
 *
 * Remote MCP is OAuth 2.1 — the servers reject a pasted bearer token, which is
 * why a URL typed into mcp-servers.json could never connect to one. The SDK
 * ships the whole orchestrator (discovery, RFC 7591 dynamic registration,
 * PKCE, refresh); what was missing on this side was a provider to persist the
 * result and a listener to catch the redirect.
 *
 * Connector-backed servers keep their own provider (encrypted secret store,
 * connectors/lib/mcp-oauth-provider.ts). This is the same protocol for servers
 * that have no connector row behind them.
 */

import { APP_NAME } from "@shared/brand.js";
import { shell } from "electron";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { startCallbackServer } from "./callback.js";
import {
  clearRecord,
  credentialKey,
  hasTokens,
  readRecord,
  writeRecord,
} from "./store.js";

export { hasTokens as hasMcpTokens } from "./store.js";

const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/**
 * Provider over the on-disk record.
 *
 * `redirectUrl` is injected before the flow starts rather than fixed at
 * construction: the loopback port is not known until the listener is up, and
 * registering a port that is not the one in use is what breaks strict servers.
 */
class FileMcpOAuthProvider implements OAuthClientProvider {
  private redirect: string | undefined;
  private csrfState: string | undefined;

  constructor(
    private readonly key: string,
    private readonly serverUrl: string,
  ) {}

  setRedirectUrl(url: string): void {
    this.redirect = url;
  }

  /** The SDK reads `state` from here when building the authorization URL —
   * it is not an option on auth(). Handing it the listener's value is what
   * lets the callback verify the response belongs to this attempt. */
  setState(state: string): void {
    this.csrfState = state;
  }

  state(): string {
    if (!this.csrfState)
      throw new Error("OAuth state was not set before starting the flow.");
    return this.csrfState;
  }

  get redirectUrl(): string | URL | undefined {
    // Never undefined: the SDK reads a MISSING redirectUrl as "this client
    // uses a non-interactive grant" and jumps straight to fetchToken — which
    // throws "Either provider.prepareTokenRequest() or authorizationCode is
    // required" WITHOUT ever trying the stored refresh token. That was every
    // background reconnect with an expired access token. The placeholder is
    // never registered (clientMetadata only lists a real listener) and never
    // opened (redirectToAuthorization refuses when no flow is bound).
    return this.redirect ?? "http://127.0.0.1/oauth-callback-unbound";
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: APP_NAME,
      redirect_uris: this.redirect ? [this.redirect] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const rec = readRecord(this.key);
    if (!rec?.clientId) return undefined;
    return {
      client_id: rec.clientId,
      ...(rec.clientSecret ? { client_secret: rec.clientSecret } : {}),
    };
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    writeRecord(this.key, {
      serverUrl: this.serverUrl,
      clientId: info.client_id,
      clientSecret: info.client_secret ?? undefined,
    });
  }

  tokens(): OAuthTokens | undefined {
    const rec = readRecord(this.key);
    if (!rec?.tokens) return undefined;
    try {
      return JSON.parse(rec.tokens) as OAuthTokens;
    } catch {
      return undefined;
    }
  }

  saveTokens(tokens: OAuthTokens): void {
    writeRecord(this.key, {
      serverUrl: this.serverUrl,
      tokens: JSON.stringify(tokens),
      // The verifier is single-use; keeping it after the exchange is a
      // credential lying around for no reason.
      codeVerifier: undefined,
    });
  }

  saveCodeVerifier(codeVerifier: string): void {
    // A background instance (no listener bound) can reach "start a new
    // authorization" when a refresh fails; its verifier write would clobber
    // the one an interactive sign-in is depending on. Only a flow that can
    // complete the exchange may write.
    if (!this.redirect) return;
    writeRecord(this.key, { serverUrl: this.serverUrl, codeVerifier });
  }

  codeVerifier(): string {
    return readRecord(this.key)?.codeVerifier ?? "";
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // A background reconnect whose refresh failed lands here with the
    // placeholder redirect in the URL — opening that tab would send the user
    // through a sign-in whose callback goes nowhere. Fail plainly instead;
    // the UI's own Sign in button runs the flow with a real listener.
    if (!this.redirect)
      throw new Error("This MCP server needs you to sign in again.");
    void shell.openExternal(authorizationUrl.toString());
  }

  invalidateCredentials(): void {
    clearRecord(this.key);
  }
}

/**
 * A provider for an ordinary connection, or undefined when there is nothing
 * stored.
 *
 * Handing the transport a provider with no tokens makes it attempt an
 * interactive flow at connect time — from a background reconnect, with no
 * browser open, that hangs instead of failing. Without a provider the 401
 * surfaces plainly and the UI can offer "Sign in".
 */
export function mcpAuthProvider(
  serverName: string,
  serverUrl: string,
): OAuthClientProvider | undefined {
  if (!hasTokens(serverName, serverUrl)) return undefined;
  return new FileMcpOAuthProvider(
    credentialKey(serverName, serverUrl),
    serverUrl,
  );
}

/** Run the browser sign-in for a server. Resolves once tokens are stored. */
export async function signInMcpServer(
  serverName: string,
  serverUrl: string,
): Promise<void> {
  const key = credentialKey(serverName, serverUrl);
  const provider = new FileMcpOAuthProvider(key, serverUrl);

  // Listener first: its port becomes the registered redirect_uri.
  const callback = await startCallbackServer();
  provider.setRedirectUrl(callback.url);
  provider.setState(callback.state);

  try {
    const first = await auth(provider, { serverUrl });
    if (first === "AUTHORIZED") return; // already had a usable token
    if (first !== "REDIRECT")
      throw new Error(`Unexpected result from the OAuth start: ${first}.`);

    const code = await callback.waitForCode(SIGN_IN_TIMEOUT_MS);

    const second = await auth(provider, {
      serverUrl,
      authorizationCode: code,
    });
    if (second !== "AUTHORIZED")
      throw new Error(`Token exchange did not complete (${second}).`);
  } finally {
    callback.close();
  }
}

/** Forget a server's credentials (Sign out). */
export function signOutMcpServer(serverName: string, serverUrl: string): void {
  clearRecord(credentialKey(serverName, serverUrl));
}
