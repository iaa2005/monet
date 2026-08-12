/**
 * Feature gates and tunables the engine consults about itself.
 *
 * Sixty-six places in the engine ask "is this feature on?" or "what is this
 * limit?", and upstream every one of those was a GrowthBook lookup — remote
 * config served alongside Anthropic's event pipeline, with a local default as
 * the fallback.
 *
 * The fallback was the only branch that ever ran here. GrowthBook switches on
 * with first-party event logging, which needs Anthropic auth; the two
 * override paths in front of it are both gated on USER_TYPE=ant. So in this
 * app every call already returned its default, every gate already returned
 * false, and the price of that was pulling 1155 lines of Statsig migration
 * logic, a disk cache and an exposure logger into the bundle.
 *
 * This returns the same answers directly. The one thing added back is an
 * override that works for US: set MONET_GATES to a JSON object and any named
 * feature takes that value. What was Anthropic-internal remote config becomes
 * a local switch for trying a branch of engine behaviour without editing it.
 *
 *   MONET_GATES='{"tengu-swarm-max":8,"some_gate":true}' npm run dev
 */

let parsed: Record<string, unknown> | null | undefined;

function overrides(): Record<string, unknown> | null {
  if (parsed === undefined) {
    parsed = null;
    const raw = process.env.MONET_GATES;
    if (raw) {
      try {
        const v: unknown = JSON.parse(raw);
        if (v && typeof v === "object" && !Array.isArray(v))
          parsed = v as Record<string, unknown>;
        else console.warn("[gates] MONET_GATES is not a JSON object — ignored");
      } catch (err) {
        console.warn(
          `[gates] MONET_GATES is not valid JSON — ignored: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
  return parsed;
}

/** A tunable's value: the override if one is set, otherwise the default the
 *  call site declared. */
export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  feature: string,
  defaultValue: T,
): T {
  const o = overrides();
  return o && feature in o ? (o[feature] as T) : defaultValue;
}

/** Upstream this refreshed in the background; with no remote to refresh from
 *  it was already an alias. */
export function getFeatureValue_CACHED_WITH_REFRESH<T>(
  feature: string,
  defaultValue: T,
  _refreshIntervalMs?: number,
): T {
  return getFeatureValue_CACHED_MAY_BE_STALE(feature, defaultValue);
}

export function getDynamicConfig_CACHED_MAY_BE_STALE<T>(
  configName: string,
  defaultValue: T,
): T {
  return getFeatureValue_CACHED_MAY_BE_STALE(configName, defaultValue);
}

export async function getDynamicConfig_BLOCKS_ON_INIT<T>(
  configName: string,
  defaultValue: T,
): Promise<T> {
  return getFeatureValue_CACHED_MAY_BE_STALE(configName, defaultValue);
}

/** A gate with no declared default is off. That is what the original returned
 *  whenever GrowthBook was disabled, which here was always. */
export function checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
  gate: string,
): boolean {
  const o = overrides();
  return o && gate in o ? Boolean(o[gate]) : false;
}

export async function checkSecurityRestrictionGate(
  gate: string,
): Promise<boolean> {
  return checkStatsigFeatureGate_CACHED_MAY_BE_STALE(gate);
}

export async function checkGate_CACHED_OR_BLOCKING(
  gate: string,
): Promise<boolean> {
  return checkStatsigFeatureGate_CACHED_MAY_BE_STALE(gate);
}
