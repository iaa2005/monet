/**
 * Model routing — which model does the cheap work.
 *
 * Several things run a model that is not the conversation: the per-turn memory
 * log pass, the nightly consolidation, the Reflect digest. All of them ran on
 * whatever the user picked for chatting, so a frontier model was being billed
 * to turn "user prefers bun" into a bullet point.
 *
 * A background model can be any configured provider — including a local one.
 * Ollama, LM Studio and llama.cpp's own server all speak the OpenAI-compatible
 * protocol this app already implements, and the Authorization header is only
 * sent when an API key is set, so a local endpoint needs no key and no new
 * transport.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";
import { getProviderManager } from "./manager.js";
import type { LLMProvider } from "./types.js";

export interface ModelRouting {
  /** Provider id for background work. Empty = use the active provider. */
  backgroundProviderId: string;
  /** Model name on that provider. Empty = that provider's own default. */
  backgroundModel: string;
}

const EMPTY: ModelRouting = { backgroundProviderId: "", backgroundModel: "" };

function routingFile(): string {
  return join(getDataDir(), "model-routing.json");
}

export function getModelRouting(): ModelRouting {
  try {
    if (!existsSync(routingFile())) return { ...EMPTY };
    const raw = JSON.parse(readFileSync(routingFile(), "utf-8")) as Partial<ModelRouting>;
    return {
      backgroundProviderId:
        typeof raw.backgroundProviderId === "string" ? raw.backgroundProviderId : "",
      backgroundModel: typeof raw.backgroundModel === "string" ? raw.backgroundModel : "",
    };
  } catch {
    return { ...EMPTY };
  }
}

export function setModelRouting(patch: Partial<ModelRouting>): ModelRouting {
  const next = { ...getModelRouting(), ...patch };
  writeFileSync(routingFile(), JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export interface ResolvedModel {
  provider: LLMProvider;
  model: string;
}

/**
 * The provider+model background work should use.
 *
 * Falls back to the active provider whenever the configured one is missing or
 * has been deleted — background work degrading to the main model is annoying,
 * background work silently not running at all is a bug the user can't see.
 */
export function resolveBackgroundModel(): ResolvedModel | null {
  const mgr = getProviderManager();
  const routing = getModelRouting();
  if (routing.backgroundProviderId) {
    const p = mgr.get(routing.backgroundProviderId);
    if (p) return { provider: p, model: routing.backgroundModel || p.model };
  }
  const active = mgr.getActive();
  return active ? { provider: active, model: active.model } : null;
}

/** A named model on a named provider, for callers that pick explicitly
 * (a routine that pins its own model). Falls back the same way. */
export function resolveModel(
  providerId?: string,
  model?: string,
): ResolvedModel | null {
  const mgr = getProviderManager();
  if (providerId) {
    const p = mgr.get(providerId);
    if (p) return { provider: p, model: model || p.model };
  }
  const active = mgr.getActive();
  return active ? { provider: active, model: model || active.model } : null;
}
