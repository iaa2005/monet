/**
 * OpenRouter metadata API client — model catalog and balance. Separate from
 * OpenAICompatClient (which handles /chat/completions streaming).
 *
 * Endpoints (all wrap their payload in { data: … } — unwrap or every field
 * reads undefined, which is exactly the bug that made the balance show
 * nothing):
 *   GET /api/v1/models   — catalog: pricing ($/token strings), context,
 *                          modalities, supported_parameters
 *   GET /api/v1/key      — THIS key: label, usage ($ spent by the key),
 *                          limit / limit_remaining (key cap, null = none)
 *   GET /api/v1/credits  — the ACCOUNT: total_credits purchased,
 *                          total_usage spent; balance = credits − usage
 */

import { fetchRetry } from "../net-fetch.js";
import type { Modality } from "../provider/types.js";

// ─── Types ───────────────────────────────────────────────────────────────

export interface ORModel {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
    image?: string;
    request?: string;
  };
  architecture: {
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
  };
  supported_parameters: string[];
  top_provider?: {
    context_length?: number;
    /** Absent/null for many models — leave max output unset then. */
    max_completion_tokens?: number | null;
  };
}

/** Combined /key + /credits picture for the settings UI. Every field is
 * optional: the two endpoints fail independently (a restricted key can read
 * one and not the other) and we show whatever we got. */
export interface ORBalance {
  /** Key label (the name the user gave it in OpenRouter). */
  label?: string;
  isFreeTier?: boolean;
  /** $ spent through THIS key. */
  keyUsage?: number;
  /** Key spending cap; null/absent = no cap. */
  keyLimit?: number | null;
  keyLimitRemaining?: number | null;
  /** Account-wide: credits purchased and lifetime usage. */
  totalCredits?: number;
  totalUsage?: number;
  /** totalCredits − totalUsage, when both known. */
  balance?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const BASE = "https://openrouter.ai/api/v1";

async function orGet<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetchRetry(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const json = (await res.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string };
  };
  if (!res.ok)
    throw new Error(
      `OpenRouter ${path}: ${json.error?.message ?? `HTTP ${res.status}`}`,
    );
  // Every OpenRouter REST endpoint envelopes its payload in { data }.
  return (json.data ?? (json as unknown)) as T;
}

/** OpenRouter prices are $/token strings; show $/1M. Negative values mean
 * "variable/BYOK" — treat as unknown rather than a nonsense negative price. */
export function pricePerMillion(
  perTokenStr: string | undefined,
): number | undefined {
  if (!perTokenStr) return undefined;
  const perToken = parseFloat(perTokenStr);
  if (!Number.isFinite(perToken) || perToken < 0) return undefined;
  return Math.round(perToken * 1_000_000 * 100) / 100;
}

/** Map OpenRouter modality strings to our Modality type. */
export function orModalities(input?: string[]): Modality[] {
  if (!input || input.length === 0) return ["text"];
  const out: Modality[] = ["text"];
  if (input.includes("image")) out.push("image");
  if (input.includes("audio")) out.push("audio");
  if (input.includes("file")) out.push("file");
  if (input.includes("video")) out.push("video");
  return out;
}

/** Whether the model takes the unified `reasoning` parameter — the ONLY
 * signal is supported_parameters; there is no top_provider flag for it. */
export function orSupportsEffort(m: ORModel): boolean {
  const p = m.supported_parameters ?? [];
  return (
    p.includes("reasoning") ||
    p.includes("include_reasoning") ||
    p.includes("reasoning_effort")
  );
}

// ─── API calls ───────────────────────────────────────────────────────────

export async function fetchORModels(apiKey: string): Promise<ORModel[]> {
  return orGet<ORModel[]>("/models", apiKey);
}

/** Balance for the settings UI: /key and /credits fetched independently —
 * whichever succeeds contributes; both failing is the only error. */
export async function fetchORBalance(apiKey: string): Promise<ORBalance> {
  const out: ORBalance = {};
  const errors: string[] = [];

  try {
    const k = await orGet<{
      label?: string;
      usage?: number;
      limit?: number | null;
      limit_remaining?: number | null;
      is_free_tier?: boolean;
    }>("/key", apiKey);
    out.label = k.label;
    out.isFreeTier = k.is_free_tier;
    out.keyUsage = k.usage;
    out.keyLimit = k.limit;
    out.keyLimitRemaining = k.limit_remaining;
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  try {
    const c = await orGet<{ total_credits?: number; total_usage?: number }>(
      "/credits",
      apiKey,
    );
    out.totalCredits = c.total_credits;
    out.totalUsage = c.total_usage;
    if (c.total_credits != null && c.total_usage != null)
      out.balance = Math.round((c.total_credits - c.total_usage) * 100) / 100;
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  if (errors.length === 2) throw new Error(errors[0]);
  return out;
}
