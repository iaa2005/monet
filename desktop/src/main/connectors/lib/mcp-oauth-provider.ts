/**
 * OAuth for connector-backed remote MCP servers (RFC 9728 + RFC 7591 DCR).
 *
 * The MCP SDK's auth() is a two-step orchestrator:
 *  1. auth(provider, { serverUrl }) → discovery + DCR + authorization URL → REDIRECT
 *  2. auth(provider, { serverUrl, authorizationCode }) → exchange → AUTHORIZED
 *
 * Between the steps a loopback listener captures the code. This module runs
 * both and bridges the provider to the encrypted secret store.
 *
 * Three rules here were learned the hard way, from a connector that opened
 * half a dozen browser tabs on every launch and then could not be signed in
 * at all without deleting it:
 *
 * **A background connection never opens a browser.** The transport calls
 * auth() itself on a 401. Given a provider, the SDK's answer to "no usable
 * token" is to start an interactive flow — from a reconnect nobody asked
 * for, that means tabs appearing while the user is doing something else,
 * one per attempt, and `ensureConnected()` runs before every turn. A
 * background provider refuses to redirect: it can still REFRESH silently,
 * which is the only thing a background connection should be able to do.
 *
 * **One flow owns its own state.** The listener, its port, the CSRF state
 * and the PKCE verifier belong to a single sign-in. They used to be module
 * globals, so a second attempt overwrote the first one's verifier and
 * redirect port — and the tab the user actually completed then failed the
 * exchange, permanently, because the stored verifier was somebody else's.
 *
 * **The registered redirect_uri is the real one.** The listener starts
 * BEFORE registration, so `http://127.0.0.1:<port>` is what gets registered
 * and what comes back. Registering `127.0.0.1:0` and rewriting the port
 * afterwards is rejected by any server that checks — which is the point of
 * registering it.
 */

import { APP_NAME } from "@shared/brand.js";
import { shell } from "electron";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { patchSecret, getSecret } from "../store.js";
import { startCallbackServer } from "../../mcp/oauth/callback.js";

const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/**
 * Sign-ins in flight, by account. A second request joins the first instead
 * of starting a rival flow — two flows for one account cannot both win, and
 * the loser used to leave the account's verifier pointing at its own attempt.
 */
const inFlight = new Map<string, Promise<void>>();

/** Raised when a background connection would have needed the browser. */
export class InteractiveAuthRequired extends Error {
  constructor(readonly accountId: string) {
    super("This connector needs you to sign in again.");
    this.name = "InteractiveAuthRequired";
  }
}

export class ConnectorOAuthProvider implements OAuthClientProvider {
  /** Set only for an interactive flow; absent means "must not redirect". */
  private redirect: string | undefined;
  private csrfState: string | undefined;

  constructor(
    private accountId: string,
    private readonly interactive = false,
  ) {}

  bindFlow(redirectUrl: string, state: string): void {
    this.redirect = redirectUrl;
    this.csrfState = state;
  }

  get redirectUrl(): string | URL | undefined {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: APP_NAME,
      // The real listener, or nothing: a placeholder port would be
      // registered and then never used.
      redirect_uris: this.redirect ? [this.redirect] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /** The SDK reads this when building the authorization URL, so the value
   * has to be the one the listener will check the callback against. */
  state(): string {
    if (!this.csrfState)
      throw new Error("OAuth state was not set before starting the flow.");
    return this.csrfState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const s = getSecret(this.accountId);
    if (!s.mcpClientId) return undefined;
    return {
      client_id: s.mcpClientId,
      ...(s.mcpClientSecret ? { client_secret: s.mcpClientSecret } : {}),
    };
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    patchSecret(this.accountId, {
      mcpClientId: info.client_id,
      mcpClientSecret: info.client_secret ?? "",
    });
  }

  tokens(): OAuthTokens | undefined {
    const s = getSecret(this.accountId);
    if (!s.mcpOauthTokens) return undefined;
    try {
      return JSON.parse(s.mcpOauthTokens) as OAuthTokens;
    } catch {
      return undefined;
    }
  }

  saveTokens(tokens: OAuthTokens): void {
    // A refresh returns a new access token and often a rotated refresh
    // token; both replace what was stored, which is what keeps a long-idle
    // account signed in instead of sending it back to the browser.
    patchSecret(this.accountId, { mcpOauthTokens: JSON.stringify(tokens) });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.interactive) throw new InteractiveAuthRequired(this.accountId);
    await shell.openExternal(authorizationUrl.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    patchSecret(this.accountId, { mcpCodeVerifier: codeVerifier });
  }

  codeVerifier(): string {
    return getSecret(this.accountId).mcpCodeVerifier ?? "";
  }

  invalidateCredentials(): void {
    patchSecret(this.accountId, {
      mcpOauthTokens: "",
      mcpClientId: "",
      mcpClientSecret: "",
      mcpCodeVerifier: "",
    });
  }
}

/**
 * The provider a BACKGROUND connection may use, or undefined.
 *
 * Undefined without stored tokens on purpose: an empty provider makes the
 * transport start an interactive flow from a reconnect, and a plain 401 is
 * what lets the UI offer "Sign in" instead.
 */
export function connectorAuthProvider(
  accountId: string,
): OAuthClientProvider | undefined {
  if (!getSecret(accountId).mcpOauthTokens) return undefined;
  return new ConnectorOAuthProvider(accountId, false);
}

/** Run the browser sign-in for a connector account. Resolves once tokens are
 * stored. Concurrent calls for the same account share one flow. */
export function signInRemoteMcp(
  accountId: string,
  serverUrl: string,
): Promise<void> {
  const running = inFlight.get(accountId);
  if (running) return running;
  const p = runSignIn(accountId, serverUrl).finally(() =>
    inFlight.delete(accountId),
  );
  inFlight.set(accountId, p);
  return p;
}

async function runSignIn(accountId: string, serverUrl: string): Promise<void> {
  const provider = new ConnectorOAuthProvider(accountId, true);

  // Listener first: its port is what gets registered and what comes back.
  const callback = await startCallbackServer();
  provider.bindFlow(callback.url, callback.state);

  try {
    const first = await auth(provider, { serverUrl });
    if (first === "AUTHORIZED") return; // a refresh was enough
    if (first !== "REDIRECT")
      throw new Error(`Unexpected result from the OAuth start: ${first}.`);

    const code = await callback.waitForCode(SIGN_IN_TIMEOUT_MS);

    const second = await auth(provider, { serverUrl, authorizationCode: code });
    if (second !== "AUTHORIZED")
      throw new Error(`Token exchange did not complete (${second}).`);
  } catch (e) {
    // A half-finished flow leaves a verifier that matches nothing. Left
    // behind, it is what makes the NEXT attempt fail too — the state the
    // user could only clear by deleting the connector.
    patchSecret(accountId, { mcpCodeVerifier: "" });
    throw e;
  } finally {
    callback.close();
  }
}
