/**
 * OAuthClientProvider for remote MCP servers (RFC 9728 + RFC 7591 DCR).
 *
 * The MCP SDK's auth() is a two-step orchestrator:
 *  1. auth(provider, { serverUrl }) → discovery + DCR + builds auth URL → REDIRECT
 *  2. auth(provider, { serverUrl, authorizationCode }) → exchange → AUTHORIZED
 *
 * Between steps, a loopback HTTP server captures the callback code. This
 * module runs both steps and bridges the provider's methods to the encrypted
 * secret store — the same safeStorage-backed persistence Google OAuth uses.
 */

import { APP_NAME } from "@shared/brand.js";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
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

const CLIENT_METADATA: OAuthClientMetadata = {
  client_name: APP_NAME,
  redirect_uris: ["http://127.0.0.1:0"],
  grant_types: ["authorization_code", "refresh_token"],
  token_endpoint_auth_method: "none",
};

/** The callback URL the loopback server is listening on. */
let callbackUrl: string | undefined;
/** Resolves when the loopback server captures the auth code. */
let codeResolver: ((code: string) => void) | undefined;
let activeServer: Server | undefined;

/**
 * Run the full OAuth flow for a remote MCP server.
 * Called from the IPC layer; stores tokens in the connector's encrypted secret.
 */
export async function signInRemoteMcp(
  accountId: string,
  serverUrl: string,
): Promise<void> {
  const provider = new ConnectorOAuthProvider(accountId);

  // Step 1: discovery + DCR + authorization URL. The SDK calls
  // redirectToAuthorization(), which starts the loopback server and opens
  // the browser. auth() returns REDIRECT — we then wait for the code.
  callbackUrl = undefined;
  codeResolver = undefined;
  const result1 = await auth(provider, { serverUrl });
  if (result1 !== "REDIRECT")
    throw new Error(`MCP OAuth: unexpected result ${result1}.`);

  // Wait for the loopback server to capture the code.
  if (!callbackUrl) throw new Error("MCP OAuth: no callback URL set.");
  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for MCP sign-in (5 minutes)."));
    }, 5 * 60_000);
    codeResolver = (c) => {
      clearTimeout(timeout);
      resolve(c);
    };
  });

  // Step 2: exchange the code for tokens. The SDK loads the verifier from
  // the provider, calls the token endpoint, and saves tokens via the provider.
  const result2 = await auth(provider, { serverUrl, authorizationCode: code });
  if (result2 !== "AUTHORIZED")
    throw new Error(`MCP OAuth: token exchange failed (${result2}).`);
}

export class ConnectorOAuthProvider implements OAuthClientProvider {
  constructor(private accountId: string) {}

  get redirectUrl(): string | URL {
    return callbackUrl ?? "http://127.0.0.1:0";
  }

  get clientMetadata(): OAuthClientMetadata {
    return CLIENT_METADATA;
  }

  async state(): Promise<string> {
    return randomBytes(16).toString("hex");
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
    patchSecret(this.accountId, {
      mcpOauthTokens: JSON.stringify(tokens),
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Start a loopback server on a random port. The SDK built the auth URL
    // with redirect_uri from redirectUrl (which was 127.0.0.1:0 before the
    // server started); we rewrite it to the real port so the provider
    // matches.
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      if (err) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          "<!doctype html><body style='font:15px system-ui;display:grid;place-items:center;height:90vh'>" +
            "<div style='text-align:center'><h2>Sign-in cancelled</h2><p>You can close this tab.</p></div></body>",
        );
        server.close();
        return;
      }
      if (code) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          "<!doctype html><body style='font:15px system-ui;display:grid;place-items:center;height:90vh'>" +
            "<div style='text-align:center'><h2>Signed in</h2><p>Close this tab and return to the app.</p></div></body>",
        );
        server.close();
        if (codeResolver) codeResolver(code);
        return;
      }
      res.writeHead(404).end();
    });

    activeServer = server;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    callbackUrl = `http://127.0.0.1:${port}`;

    // Rewrite the redirect_uri in the authorization URL to the real port.
    const fixedUrl = new URL(authorizationUrl.toString());
    fixedUrl.searchParams.set("redirect_uri", callbackUrl);

    void shell.openExternal(fixedUrl.toString());
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
