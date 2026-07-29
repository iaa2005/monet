/**
 * One-shot loopback listener for an OAuth redirect.
 *
 * Started BEFORE the authorization URL is built, so the real port can be
 * registered as the redirect_uri. The existing connector flow does it the
 * other way round — listen on port 0, then rewrite `redirect_uri` in the
 * finished authorization URL — which leaves Dynamic Client Registration
 * holding `http://127.0.0.1:0` while the request carries a different port. A
 * server that checks the redirect_uri against what was registered (most do,
 * it is the point of registering it) rejects that.
 *
 * One server per flow, no module state: two sign-ins can be in progress
 * without one capturing the other's code.
 */

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

export interface CallbackServer {
  /** The redirect_uri to register and to send the user to. */
  readonly url: string;
  /** The `state` this flow expects back. */
  readonly state: string;
  /** Resolves with the authorization code, or rejects on error/timeout. */
  waitForCode(timeoutMs: number): Promise<string>;
  close(): void;
}

function page(title: string, body: string): string {
  return (
    "<!doctype html><meta charset='utf-8'>" +
    "<body style=\"font:15px system-ui;display:grid;place-items:center;height:90vh;margin:0\">" +
    `<div style="text-align:center"><h2>${title}</h2><p>${body}</p></div></body>`
  );
}

export async function startCallbackServer(): Promise<CallbackServer> {
  const state = randomBytes(16).toString("hex");
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((err: Error) => void) | undefined;
  let settled = false;

  const finish = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    fn();
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const returnedState = url.searchParams.get("state");

    const reply = (title: string, body: string): void => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page(title, body));
    };

    if (error) {
      reply("Sign-in cancelled", "You can close this tab.");
      finish(() =>
        rejectCode?.(new Error(`The provider returned "${error}".`)),
      );
      return;
    }

    if (!code) {
      res.writeHead(404).end();
      return;
    }

    // The whole reason `state` exists: without this check any page on the
    // internet could send the browser to this port with a code of its
    // choosing and have it exchanged against the user's client registration.
    // The previous implementation generated a state and never looked at it.
    if (returnedState !== state) {
      reply(
        "Sign-in rejected",
        "The response did not match this sign-in attempt.",
      );
      finish(() =>
        rejectCode?.(
          new Error(
            "OAuth state mismatch — the callback did not belong to this sign-in.",
          ),
        ),
      );
      return;
    }

    reply("Signed in", "Close this tab and return to the app.");
    finish(() => resolveCode?.(code));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}/callback`,
    state,
    waitForCode(timeoutMs: number): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          finish(() =>
            reject(
              new Error(
                `Timed out after ${Math.round(timeoutMs / 60_000)} minutes waiting for the browser sign-in.`,
              ),
            ),
          );
        }, timeoutMs);
        resolveCode = (c) => {
          clearTimeout(timer);
          resolve(c);
        };
        rejectCode = (e) => {
          clearTimeout(timer);
          reject(e);
        };
      });
    },
    close(): void {
      server.close();
    },
  };
}
