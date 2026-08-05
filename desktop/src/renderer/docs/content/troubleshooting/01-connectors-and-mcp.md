---
title: Connectors and MCP servers
description: Red rows under connectors, sign-in loops, and how to tell an auth problem from a network one.
order: 1
---

## "Either provider.prepareTokenRequest() or authorizationCode is required"

A connector shows *authorised* but Test fails with this exact red text.

**What it was:** the MCP SDK treats a client without a redirect URL as a
non-interactive one and skips the token-refresh path entirely — and the
app's background connections deliberately carry no redirect URL so that a
reconnect can never pop a browser tab. Result: the moment an access token
expired, every background reconnect died on this error instead of silently
refreshing.

**What to do:** update past 2026-08-05 and restart the app. If the row is
still red after a restart, the *refresh* token has expired too — click
**Sign in** once; from then on refresh works silently again.

## "This connector needs you to sign in again."

Not an error — a verdict. The stored token was refused and a silent refresh
was not possible, so the one thing left is an interactive sign-in. The
button next to the message runs it. The app never opens sign-in tabs on its
own: a background connection is allowed to refresh, never to redirect.

## Half a dozen browser tabs opened on launch (historic)

Old defect, fixed: a background reconnect could start an interactive OAuth
flow, once per attempt. If you ever see spontaneous sign-in tabs again,
that is a regression worth reporting — the rule is *background never opens
a browser*.

## The sign-in tab completed, but the app says the exchange failed

Two sign-in attempts for the same account used to overwrite each other's
one-time keys, so the tab you actually finished belonged to a dead attempt.
Now concurrent attempts share one flow — but if you managed to wedge it:
close all sign-in tabs, wait out the 5-minute flow timeout (or restart the
app), then sign in once.

## Is it auth, or is it the network?

The UI answers this for you — the Sign-in offer appears only for verdicts
that are actually about credentials:

| Symptom under the row | Meaning | Do |
| --- | --- | --- |
| `Missing Authorization`, `invalid_token`, `401`, `token_expired`, `invalid_grant`, `Forbidden` | the server refused the credential | Sign in |
| `getaddrinfo ENOTFOUND …`, timeouts | network / DNS | check connectivity; signing in would burn a working grant for nothing |
| `Internal Server Error (500)` | their side | wait |
| `connecting…` | not a verdict yet | wait |

## Deleting as the last resort

Deleting a connector clears its tokens, its client registration and any
in-flight sign-in state. It is the sledgehammer that always works — but
after the fixes above you should not need it for auth reasons.
