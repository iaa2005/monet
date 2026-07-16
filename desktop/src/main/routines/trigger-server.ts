/**
 * Local HTTP trigger server — lets routines be kicked off "by API or webhook"
 * (the other two triggers from the Routines subtitle). Bound to 127.0.0.1 only:
 *
 *   POST /webhook/<webhookId>      → fire the routine with that webhook id
 *   POST /run/<routineId>          → fire by id (Authorization: Bearer <apiKey>)
 *   GET  /                         → health
 *
 * The request body is passed to the run as trigger context. External services
 * can't reach 127.0.0.1 directly — expose it with a tunnel (ngrok/cloudflared)
 * when you need inbound webhooks from the internet.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { Server } from "http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";
import { listRoutines, getRoutine } from "./store.js";
import { executeRoutine } from "./scheduler.js";

export interface TriggerConfig {
  port: number;
  apiKey: string;
}

function configPath(): string {
  return join(getDataDir(), "routines-trigger.json");
}

let config: TriggerConfig | null = null;

export function getTriggerConfig(): TriggerConfig {
  if (config) return config;
  try {
    if (existsSync(configPath()))
      config = JSON.parse(readFileSync(configPath(), "utf-8")) as TriggerConfig;
  } catch {
    /* regenerate below */
  }
  if (!config) {
    config = { port: 4319, apiKey: randomUUID().replace(/-/g, "") };
    try {
      writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf-8");
    } catch {
      /* best-effort */
    }
  }
  return config;
}

export function triggerBaseUrl(): string {
  return `http://127.0.0.1:${getTriggerConfig().port}`;
}

let server: Server | null = null;

function send(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) break; // cap at 1 MB
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = getTriggerConfig();
  const url = new URL(req.url ?? "/", triggerBaseUrl());

  if (req.method === "GET" && url.pathname === "/")
    return send(res, 200, { ok: true, service: "monet-routines" });

  const wh = /^\/webhook\/([^/]+)$/.exec(url.pathname);
  if (req.method === "POST" && wh) {
    const routine = listRoutines().find(
      (r) => r.trigger.kind === "webhook" && r.trigger.webhookId === wh[1],
    );
    if (!routine || !routine.enabled)
      return send(res, 404, { error: "No such webhook" });
    const body = await readBody(req).catch(() => "");
    void executeRoutine(routine, { source: "webhook", body });
    return send(res, 202, { ok: true, routine: routine.id });
  }

  const run = /^\/run\/([^/]+)$/.exec(url.pathname);
  if (req.method === "POST" && run) {
    const auth = (req.headers["authorization"] as string) || "";
    if (auth !== `Bearer ${cfg.apiKey}`)
      return send(res, 401, { error: "Unauthorized" });
    const routine = getRoutine(run[1]);
    if (!routine) return send(res, 404, { error: "No such routine" });
    const body = await readBody(req).catch(() => "");
    void executeRoutine(routine, { source: "api", body });
    return send(res, 202, { ok: true, routine: routine.id });
  }

  send(res, 404, { error: "Not found" });
}

/** Start the localhost trigger server (idempotent). */
export function startTriggerServer(): void {
  if (server) return;
  const cfg = getTriggerConfig();
  server = createServer((req, res) => {
    void handle(req, res).catch(() => send(res, 500, { error: "Internal error" }));
  });
  server.on("error", () => {
    server = null; // e.g. port in use — routines still run on schedule/manually
  });
  server.listen(cfg.port, "127.0.0.1");
}
