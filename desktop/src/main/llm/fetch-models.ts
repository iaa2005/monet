/**
 * Discover a provider's models from its own /v1/models endpoint.
 *
 * Every OpenAI-compatible server exposes this — Ollama, LM Studio, llama.cpp's
 * server, vLLM, OpenAI itself — so one call covers the whole family, including
 * a local server whose model list only its owner knows. OpenRouter has its own
 * richer catalog endpoint (openrouter-api.ts) and does not go through here.
 */

export interface DiscoveredModel {
  name: string;
  label?: string;
}

/** The shapes these servers actually return for GET /models. */
interface ModelsResponse {
  /** OpenAI / LM Studio / llama.cpp / vLLM. */
  data?: { id?: unknown; name?: unknown }[];
  /** Ollama's native /api/tags, in case someone points at that. */
  models?: { name?: unknown; model?: unknown }[];
}

export async function fetchProviderModels(
  baseURL: string,
  apiKey: string,
): Promise<DiscoveredModel[]> {
  const root = baseURL.replace(/\/+$/, "");
  const headers: Record<string, string> = { Accept: "application/json" };
  // Local servers take no key; sending an empty bearer makes some of them 401.
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${root}/models`, { headers });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`${res.status} from ${root}/models${body ? `: ${body}` : ""}`);
  }
  const json = (await res.json()) as ModelsResponse;

  const out: DiscoveredModel[] = [];
  for (const m of json.data ?? []) {
    const id = typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : "";
    if (id) out.push({ name: id });
  }
  for (const m of json.models ?? []) {
    const id =
      typeof m.model === "string" ? m.model : typeof m.name === "string" ? m.name : "";
    if (id) out.push({ name: id });
  }

  // Same model can appear in both arrays if a server answers with a hybrid shape.
  const seen = new Set<string>();
  return out
    .filter((m) => !seen.has(m.name) && seen.add(m.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}
