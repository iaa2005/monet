/**
 * models.dev catalog — model metadata without hand-typing it.
 *
 * Adding a model used to mean typing its id into an empty box and then
 * knowing, from memory, its context window and whether it can see images.
 * Nobody knows that for 5811 models, so the fields stayed blank and the app
 * guessed: 200k context for everything, text-only input. The second guess was
 * the expensive one — see inferModalities() in provider/types.ts.
 *
 * models.dev publishes that metadata as one public JSON document
 * (`https://models.dev/api.json`, ~3.2 MB, 174 providers). Kimi Code imports
 * the same document; this is the same idea wired to our ProviderModel shape.
 *
 * Verified against the live endpoint, not assumed: 200, 5811 models, input
 * modality vocabulary exactly `text | image | audio | video | pdf`, and 1100
 * models declaring a separate input limit.
 *
 * Cached on disk because it is 3 MB and changes daily at most. Nothing here
 * blocks startup: the catalog is fetched only when a user opens the picker.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";
import type { Modality, ProviderModel } from "../provider/types.js";

const CATALOG_URL = "https://models.dev/api.json";
/** A day: the document is a slow-moving reference, not live data. */
const MAX_AGE_MS = 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;

// ─── Wire shape (only the fields we read) ───────────────────────────────

interface CatalogModelEntry {
  id?: string;
  name?: string;
  family?: string;
  release_date?: string;
  status?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  open_weights?: boolean;
  limit?: { context?: number; input?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  cost?: { input?: number; output?: number };
}

interface CatalogProviderEntry {
  id?: string;
  name?: string;
  /** Base URL. Absent for several majors (anthropic, google, xai) — the SDK
   * hardcodes it there, so the UI must not present it as known. */
  api?: string;
  /** Env var names carrying the credential; shown as a hint. */
  env?: string[];
  doc?: string;
  models?: Record<string, CatalogModelEntry>;
}

type Catalog = Record<string, CatalogProviderEntry>;

// ─── What the renderer consumes ─────────────────────────────────────────

export interface CatalogModelInfo {
  /** Model id to send to the API — what goes in ProviderModel.name. */
  id: string;
  /** Human label. */
  label: string;
  family?: string;
  releaseDate?: string;
  contextLength?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  modalities: Modality[];
  supportsEffort: boolean;
  toolCall: boolean;
  openWeights: boolean;
  /** USD per 1M tokens, for display. */
  pricing?: { promptPer1M: number; completionPer1M: number };
}

export interface CatalogProviderInfo {
  id: string;
  label: string;
  baseURL?: string;
  envVars: string[];
  docURL?: string;
  modelCount: number;
}

// ─── Mapping ────────────────────────────────────────────────────────────

/**
 * models.dev input modalities → our Modality union.
 *
 * `pdf` is their name for a document attachment, which we call `file`; every
 * other name matches. An unknown string is dropped rather than passed through,
 * so a new vocabulary entry cannot smuggle an invalid Modality into a stored
 * config.
 */
export function catalogModalities(input?: string[]): Modality[] {
  const out: Modality[] = ["text"];
  for (const raw of input ?? []) {
    const m =
      raw === "pdf"
        ? "file"
        : raw === "image" || raw === "audio" || raw === "video"
          ? raw
          : null;
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

/** One catalog entry → the fields the model editor shows. */
export function toCatalogModel(
  key: string,
  entry: CatalogModelEntry,
): CatalogModelInfo {
  const id = entry.id?.trim() || key;
  return {
    id,
    label: entry.name?.trim() || id,
    family: entry.family,
    releaseDate: entry.release_date,
    contextLength: positive(entry.limit?.context),
    // Only when the catalog states one: a model whose input cap equals its
    // whole window must not be given a redundant second number that later
    // drifts from it.
    maxInputTokens: positive(entry.limit?.input),
    maxOutputTokens: positive(entry.limit?.output),
    modalities: catalogModalities(entry.modalities?.input),
    supportsEffort: entry.reasoning === true,
    toolCall: entry.tool_call !== false,
    openWeights: entry.open_weights === true,
    pricing:
      typeof entry.cost?.input === "number" &&
      typeof entry.cost?.output === "number"
        ? { promptPer1M: entry.cost.input, completionPer1M: entry.cost.output }
        : undefined,
  };
}

function positive(n: number | undefined): number | undefined {
  return typeof n === "number" && n > 0 ? n : undefined;
}

/** The picker's payload for one provider, newest models first. */
export function providerModels(
  catalog: Catalog,
  providerId: string,
): CatalogModelInfo[] {
  const entry = catalog[providerId];
  if (!entry?.models) return [];
  return Object.entries(entry.models)
    .filter(([, m]) => m.status !== "deprecated")
    .map(([k, m]) => toCatalogModel(k, m))
    .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""));
}

/** Providers that actually have models, by label. */
export function listCatalogProviders(catalog: Catalog): CatalogProviderInfo[] {
  return Object.entries(catalog)
    .map(([id, p]) => ({
      id,
      label: p.name?.trim() || id,
      baseURL: p.api?.trim() || undefined,
      envVars: p.env ?? [],
      docURL: p.doc,
      modelCount: Object.keys(p.models ?? {}).length,
    }))
    .filter((p) => p.modelCount > 0)
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Catalog entry → the stored model row. `id` is filled by the caller. */
export function toProviderModel(m: CatalogModelInfo): Omit<ProviderModel, "id"> {
  return {
    name: m.id,
    label: m.label !== m.id ? m.label : undefined,
    contextLength: m.contextLength,
    maxInputTokens: m.maxInputTokens,
    maxOutputTokens: m.maxOutputTokens,
    modalities: m.modalities,
    supportsEffort: m.supportsEffort,
    pricing: m.pricing,
  };
}

// ─── Fetch + cache ──────────────────────────────────────────────────────

function cachePath(): string {
  return join(getDataDir(), "models-dev.json");
}

interface CacheFile {
  fetchedAt: number;
  catalog: Catalog;
}

function readCache(): CacheFile | null {
  try {
    const f = cachePath();
    if (!existsSync(f)) return null;
    const parsed = JSON.parse(readFileSync(f, "utf-8")) as Partial<CacheFile>;
    if (!parsed.catalog || typeof parsed.fetchedAt !== "number") return null;
    return { fetchedAt: parsed.fetchedAt, catalog: parsed.catalog };
  } catch {
    return null;
  }
}

let inFlight: Promise<Catalog> | null = null;

/**
 * The catalog, from cache when fresh enough.
 *
 * A stale cache beats a failed fetch: offline, the picker should still show
 * yesterday's list rather than an empty one. Only a first run with no cache
 * at all can fail, and that failure is reported.
 */
export async function getCatalog(force = false): Promise<Catalog> {
  const cached = readCache();
  if (!force && cached && Date.now() - cached.fetchedAt < MAX_AGE_MS)
    return cached.catalog;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch(CATALOG_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`models.dev returned ${res.status}`);
      const catalog = (await res.json()) as Catalog;
      if (!catalog || typeof catalog !== "object" || Array.isArray(catalog))
        throw new Error("models.dev returned an unexpected shape");
      writeFileSync(
        cachePath(),
        JSON.stringify({ fetchedAt: Date.now(), catalog } satisfies CacheFile),
        "utf-8",
      );
      return catalog;
    } catch (err) {
      if (cached) return cached.catalog; // stale beats nothing
      throw err;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Age of the cached copy in ms, or null when there is none. */
export function catalogAge(): number | null {
  const c = readCache();
  return c ? Date.now() - c.fetchedAt : null;
}
