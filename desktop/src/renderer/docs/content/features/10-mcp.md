---
title: MCP servers
description: Extending the agent with tools from outside the app.
order: 10
---

MCP (Model Context Protocol) is a standard way for a program to expose tools to
an agent. Connecting one gives the agent capabilities this app did not ship.

## Transports

- **stdio** — the app launches a local program and talks to it over its
  standard streams. Configuration is a command, arguments and environment.
- **SSE** and **streamable HTTP** — a remote server over the network, addressed
  by URL.

## Authentication

A local stdio server usually takes a token through its environment. A remote
server typically uses OAuth: it directs you to sign in, and the app holds the
resulting token in the OS keystore.

> [!NOTE]
> Remote MCP servers generally reject a pasted API token — the protocol expects
> the OAuth flow. If a server refuses a token that looks correct, that is
> usually why.

## Tools and permissions

MCP tools appear alongside built-in ones, prefixed with their server's name, and
go through the same permission gate. A server supplied by a connector is checked
against that connector's permissions; a hand-written server is treated as
arbitrary and asks before use.

## In Home

Home may use MCP servers that a connector supplies, since those talk to one
signed-in service. A hand-written server is not offered in Home: it could do
anything, which is exactly what the isolated space exists to prevent.
