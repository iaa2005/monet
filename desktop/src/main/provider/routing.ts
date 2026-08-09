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
import { resolveModelOn } from "./types.js";
import { getProviderManager } from "./manager.js";
import type { ActiveModel } from "./types.js";

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
  /** Provider AND model, resolved together — see ActiveModel. */
  provider: ActiveModel;
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
  return resolveModel(
    getModelRouting().backgroundProviderId,
    getModelRouting().backgroundModel,
  );
}

/**
 * A named model on a named provider, for callers that pick explicitly (a
 * routine that pins its own model, or background work routed elsewhere).
 * Falls back to the active provider when the named one is gone.
 *
 * RESOLVED, model and all. This used to hand back `mgr.get(id)` — the stored
 * record — and take the model NAME from its flat `model` field while leaving
 * every other number on it untouched. Those numbers are written by the
 * provider form from models[0], so a routine pinned to a provider ran with
 * the first model's context window and output cap whatever model it was
 * actually using: the compaction threshold and max_tokens of something else.
 * Nothing said so, because the two were the same type.
 */
export function resolveModel(
  providerId?: string,
  model?: string,
): ResolvedModel | null {
  const mgr = getProviderManager();
  const pinned = providerId ? mgr.get(providerId) : undefined;
  const resolved = pinned
    ? resolveModelOn(pinned, model)
    : (() => {
        const p = mgr.getActiveProvider();
        return p ? resolveModelOn(p, model) : null;
      })();
  return resolved ? { provider: resolved, model: resolved.model } : null;
}
