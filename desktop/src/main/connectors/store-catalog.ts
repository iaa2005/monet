/**
 * The connector store — manifests fetched from the community repo, installed
 * into the data dir, and joined into the live registry. No app update needed
 * to add a connector; no code is ever downloaded, only manifests (see
 * services/manifest.ts for the security model).
 *
 * Repo layout (github.com/iaa2005/monet-directory):
 *   index.json                     — the catalog (array of entries)
 *   connectors/<id>/manifest.json  — the full manifest
 *   connectors/<id>/icon.svg       — optional inline-able icon
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { getDataSubdir } from "../data-dir.js";
import { fetchRetry } from "../net-fetch.js";
import {
  manifestEndpoints,
  manifestToService,
  type ConnectorManifest,
} from "./services/manifest.js";
import { BUILTIN_IDS, setInstalledServices } from "./services/registry.js";
import type { ConnectorService } from "./services/types.js";

const REPO_RAW =
  "https://raw.githubusercontent.com/iaa2005/monet-directory/main";

/** One row of index.json — enough for the store list without N fetches. */
export interface CatalogEntry {
  id: string;
  name: string;
  /** Human-friendly name for the store UI ("Google Gmail"). Falls back to `name`. */
  displayName?: string;
  company: string;
  description: string;
  version: string;
  /** Capability names, for the card ("mail", "caldav", "mcp"…). */
  capabilities: string[];
  /** Inline SVG icon, fetched from the repo alongside the catalog. */
  iconSvg?: string;
}

/** What the renderer needs to render a pre-install confirmation. */
export interface ManifestPreview {
  id: string;
  name: string;
  displayName?: string;
  version: string;
  authKind: string;
  capabilities: string[];
  /** Every endpoint/command the manifest names — the transparency line. */
  endpoints: string[];
  note?: string;
}

function storeDir(): string {
  const dir = join(getDataSubdir("connectors"), "store");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetchRetry(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

export async function fetchCatalog(): Promise<CatalogEntry[]> {
  const raw = JSON.parse(await fetchText(`${REPO_RAW}/index.json`)) as unknown;
  if (!Array.isArray(raw)) throw new Error("index.json is not an array");
  const entries = raw
    .filter(
      (e): e is CatalogEntry =>
        !!e &&
        typeof (e as CatalogEntry).id === "string" &&
        typeof (e as CatalogEntry).name === "string",
    )
    .map((e) => ({
      id: e.id,
      name: e.name,
      displayName: e.displayName,
      company: e.company ?? "",
      description: e.description ?? "",
      version: e.version ?? "0",
      capabilities: Array.isArray(e.capabilities) ? e.capabilities : [],
      iconSvg: undefined as string | undefined,
    }));
  // Fetch icons in parallel — each is a tiny SVG; failures are non-fatal.
  await Promise.all(
    entries.map(async (e) => {
      try {
        const svg = await fetchText(`${REPO_RAW}/connectors/${e.id}/icon.svg`);
        if (svg.includes("<svg")) e.iconSvg = svg;
      } catch {
        /* icon is optional */
      }
    }),
  );
  return entries;
}

async function fetchManifest(
  id: string,
): Promise<{ manifest: ConnectorManifest; iconSvg?: string }> {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) throw new Error(`Bad id: ${id}`);
  const manifest = JSON.parse(
    await fetchText(`${REPO_RAW}/connectors/${id}/manifest.json`),
  ) as ConnectorManifest;
  let iconSvg: string | undefined;
  try {
    const svg = await fetchText(`${REPO_RAW}/connectors/${id}/icon.svg`);
    if (svg.includes("<svg")) iconSvg = svg;
  } catch {
    /* icon is optional */
  }
  return { manifest, iconSvg };
}

/** Fetch + validate WITHOUT installing — powers the confirm dialog. */
export async function previewStoreConnector(id: string): Promise<ManifestPreview> {
  const { manifest, iconSvg } = await fetchManifest(id);
  // Validation IS the preview gate: an invalid manifest never gets shown as
  // installable.
  manifestToService(manifest, { builtinIds: BUILTIN_IDS, iconSvg });
  return {
    id: manifest.id,
    name: manifest.name,
    displayName: manifest.displayName,
    version: manifest.version,
    authKind: manifest.auth.kind,
    capabilities: Object.keys(manifest.capabilities),
    endpoints: manifestEndpoints(manifest),
    note: manifest.note,
  };
}

export async function installStoreConnector(id: string): Promise<void> {
  const { manifest, iconSvg } = await fetchManifest(id);
  manifestToService(manifest, { builtinIds: BUILTIN_IDS, iconSvg }); // validate
  const dir = join(storeDir(), manifest.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (iconSvg) writeFileSync(join(dir, "icon.svg"), iconSvg);
  refreshInstalledServices();
}

export function removeStoreConnector(id: string): boolean {
  const dir = join(storeDir(), id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  refreshInstalledServices();
  return true;
}

export function installedStoreIds(): string[] {
  try {
    return readdirSync(storeDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function loadInstalled(): ConnectorService[] {
  const out: ConnectorService[] = [];
  for (const id of installedStoreIds()) {
    try {
      const dir = join(storeDir(), id);
      const manifest = JSON.parse(
        readFileSync(join(dir, "manifest.json"), "utf-8"),
      ) as ConnectorManifest;
      const iconPath = join(dir, "icon.svg");
      const iconSvg = existsSync(iconPath)
        ? readFileSync(iconPath, "utf-8")
        : undefined;
      out.push(manifestToService(manifest, { builtinIds: BUILTIN_IDS, iconSvg }));
    } catch (e) {
      // A broken manifest must not take the registry down — skip it loudly.
      console.warn(
        `[connectors] skipping installed store connector "${id}":`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return out;
}

/** Re-read the store dir into the live registry (startup + every change). */
export function refreshInstalledServices(): void {
  setInstalledServices(loadInstalled());
}
