/**
 * Google sign-in for connectors (installed-app OAuth).
 *
 * Google takes an app password for mail but demands OAuth for Calendar,
 * Contacts and Drive — proven the hard way: the same password Gmail accepts
 * over IMAP is refused by CalDAV with `loginRequired`. So those need this.
 *
 * The user registers ONE OAuth client (Desktop app) in Google Cloud and pastes
 * its id/secret once; after that signing in is a browser click. A "Desktop app"
 * client secret is not really secret — Google says so, since anyone can read it
 * out of an installed binary — which is why the loopback redirect below, not
 * the secret, is what actually ties the response to this machine.
 *
 * We run the consent leg, keep the refresh token, and refresh access tokens
 * ourselves (googleAccessToken) — the DAV protocol lib takes these as a
 * provider callback (googleDavCredentials) so lib/ never imports Google code.
 */

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { shell } from "electron";
import { fetchRetry } from "../../../net-fetch.js";
import { patchSecret } from "../../store.js";
import type { DavOauthCredentials } from "../../lib/protocols/dav.js";
import type { ResolvedAccount } from "../types.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Always requested on top of whatever a preset asks for.
 *
 * Without it /oauth2/v3/userinfo returns no address, and the account is stored
 * with an empty login — which for CalDAV means a principal of
 * `/caldav/v2//user` and a connector that signs in perfectly and then can't
 * find anything. The address IS the principal here; it isn't optional.
 */
const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

/** Consent can involve account-picking, 2FA and an "unverified app" warning. */
const CONSENT_TIMEOUT_MS = 5 * 60_000;

export interface GoogleTokens {
  refreshToken: string;
  accessToken: string;
  /** Epoch ms. */
  expiry: number;
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px system-ui;display:grid;place-items:center;height:90vh;margin:0">
<div style="text-align:center"><h2 style="font-weight:500">${title}</h2><p>${body}</p></div>`;
}

/**
 * Run the consent flow and return tokens.
 *
 * PKCE is included even though a Desktop client also sends a secret: the code
 * travels back over plain loopback HTTP, and PKCE is what stops another local
 * process that raced us to the port from redeeming it.
 */
export async function googleSignIn(opts: {
  clientId: string;
  clientSecret: string;
  scopes: string[];
}): Promise<GoogleTokens> {
  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const { code, redirectUri } = await new Promise<{
    code: string;
    redirectUri: string;
  }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const gotCode = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");
      const finish = (title: string, body: string): void => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page(title, body));
        server.close();
      };
      if (err) {
        finish("Sign-in cancelled", "You can close this tab.");
        reject(new Error(`Google refused: ${err}`));
        return;
      }
      // The state check is the CSRF gate: without it any page could point your
      // browser here with a code of its own choosing.
      if (!gotCode || gotState !== state) {
        finish("Sign-in failed", "You can close this tab.");
        reject(new Error("Google's reply didn't match this request."));
        return;
      }
      const port = (server.address() as { port: number } | null)?.port;
      finish("Signed in", "You can close this tab and go back to the app.");
      resolve({ code: gotCode, redirectUri: `http://127.0.0.1:${port}` });
    });

    server.on("error", reject);
    // Port 0 = let the OS pick a free one. Google allows any loopback port for
    // Desktop clients, so nothing has to be registered up front.
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const params = new URLSearchParams({
        client_id: opts.clientId,
        redirect_uri: `http://127.0.0.1:${port}`,
        response_type: "code",
        scope: [...new Set([...opts.scopes, EMAIL_SCOPE])].join(" "),
        // offline + consent, or Google hands back a refresh token only on the
        // very first authorisation ever — reconnecting later would silently get
        // none, and the connector would die at the first token expiry.
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      void shell.openExternal(`${AUTH_URL}?${params.toString()}`);
    });

    setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for Google sign-in."));
    }, CONSENT_TIMEOUT_MS);
  });

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code_verifier: verifier,
  });
  const res = await fetchRetry(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token)
    throw new Error(
      `Token exchange failed: ${json.error_description ?? json.error ?? res.status}`,
    );
  if (!json.refresh_token)
    throw new Error(
      "Google returned no refresh token — revoke the app at myaccount.google.com/permissions and sign in again.",
    );

  return {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    expiry: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

/**
 * A usable access token, refreshing if needed.
 *
 * We do this rather than let tsdav do it, because tsdav's refresh CANNOT fail
 * loudly: on a non-ok response it returns `{}`, so the request then goes out
 * with no Authorization header at all and comes back 401 — surfacing as "cannot
 * find homeUrl", i.e. an app-password error message on an account that has no
 * app password. An expired grant has to say so.
 *
 * It expires more often than you'd think: while the OAuth consent screen is in
 * "Testing", Google expires refresh tokens after about a week, so this path is
 * the normal weekly experience until the client is published.
 */
export async function googleAccessToken(secret: {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiry?: number;
}): Promise<GoogleTokens> {
  const { clientId, clientSecret, refreshToken } = secret;
  if (!clientId || !clientSecret || !refreshToken)
    throw new Error("Not signed in to Google — connect it again in Settings.");

  // 60s of slack: a token that expires mid-request is the same as expired.
  if (secret.accessToken && (secret.expiry ?? 0) > Date.now() + 60_000)
    return {
      accessToken: secret.accessToken,
      refreshToken,
      expiry: secret.expiry as number,
    };

  const res = await fetchRetry(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    // invalid_grant is the one worth naming: expired, revoked, or the client
    // was rebuilt. Nothing here is fixable by retrying.
    if (json.error === "invalid_grant")
      throw new Error(
        "Your Google sign-in has expired — connect the connector again. " +
          "If this keeps happening weekly, it's because the OAuth consent screen is still in “Testing”: " +
          "Google expires those refresh tokens after ~7 days. Set the app to “In production” in Google Cloud to stop it.",
      );
    throw new Error(
      `Google refused to refresh the token: ${json.error_description ?? json.error ?? res.status}`,
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken,
    expiry: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

/**
 * OAuth credentials provider for the DAV protocol lib (DavConfig.oauth).
 * Refreshes up front and persists the rotated token, then hands tsdav a
 * ready-to-use credential set. This callback is how Google-ness reaches the
 * company-agnostic lib/protocols/dav.ts.
 */
export async function googleDavCredentials(
  acct: ResolvedAccount,
): Promise<DavOauthCredentials> {
  const tokens = await googleAccessToken(acct.secret);
  if (tokens.accessToken !== acct.secret.accessToken)
    patchSecret(acct.account.id, tokens);
  return {
    clientId: acct.secret.clientId,
    clientSecret: acct.secret.clientSecret,
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiration: tokens.expiry,
    tokenUrl: GOOGLE_TOKEN_URL,
  };
}
