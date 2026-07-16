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
 * We only run the consent leg and keep the refresh token; tsdav does the rest
 * (it refreshes an expired access token by itself given clientId/secret/refresh).
 */

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { shell } from "electron";
import { fetchRetry } from "../../net-fetch.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

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
        scope: opts.scopes.join(" "),
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
