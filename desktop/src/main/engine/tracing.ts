/**
 * Spans the engine opens around its own work — and does not send anywhere.
 *
 * The leak instruments a turn with OpenTelemetry: an interaction span per
 * prompt, an LLM-request span per call, tool spans nested inside it, hook
 * spans, plus a second Perfetto tracer for the multi-agent timeline. All of
 * it exports to Anthropic's collector.
 *
 * We do not send traces to Anthropic, and this app already has its own view of
 * a turn — the task log the renderer draws from. So the spans become no-ops
 * with the same shapes: the call sites stay where they are, they cost a
 * function call, and nothing leaves the machine.
 *
 * Kept rather than deleted from the call sites for one reason: the placement
 * is information. `startToolExecutionSpan` sits exactly where execution
 * begins, after the permission gate and before the tool runs. If we ever want
 * local timing, the seams are already cut.
 */

/** Stands in for an OTel Span. Nothing reads it; it only has to be passable
 *  back to the matching end* call. */
export interface Span {
  readonly noop: true;
}

const SPAN: Span = { noop: true };

export function isEnhancedTelemetryEnabled(): boolean {
  return false;
}
export function isBetaTracingEnabled(): boolean {
  return false;
}
export function isPerfettoTracingEnabled(): boolean {
  return false;
}

export function startInteractionSpan(_userPrompt: string): Span {
  return SPAN;
}
export function endInteractionSpan(): void {}

export function startLLMRequestSpan(..._args: unknown[]): Span {
  return SPAN;
}
export function endLLMRequestSpan(..._args: unknown[]): void {}

export function startToolSpan(
  _toolName: string,
  _toolAttributes?: Record<string, string | number | boolean>,
  _toolInput?: string,
): Span {
  return SPAN;
}
export function endToolSpan(_toolResult?: string, _resultTokens?: number): void {}

export function startToolBlockedOnUserSpan(): Span {
  return SPAN;
}
export function endToolBlockedOnUserSpan(
  _decision?: string,
  _source?: string,
): void {}

export function startToolExecutionSpan(): Span {
  return SPAN;
}
export function endToolExecutionSpan(_metadata?: {
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}): void {}

export function addToolContentEvent(
  _eventName: string,
  _attributes: Record<string, string | number | boolean>,
): void {}

export function startHookSpan(
  _hookEvent: string,
  _hookName: string,
  _numHooks: number,
  _hookDefinitions: string,
): Span {
  return SPAN;
}
export function endHookSpan(
  _span: Span,
  _metadata?: Record<string, unknown>,
): void {}

export function getCurrentSpan(): Span | null {
  return null;
}

export async function executeInSpan<T>(
  _name: unknown,
  fn: () => T | Promise<T>,
): Promise<T> {
  return await fn();
}

export function clearBetaTracingState(): void {}

// ── Perfetto: the multi-agent timeline ────────────────────────────────────
export function initializePerfettoTracing(): void {}
export function registerAgent(..._args: unknown[]): void {}
export function unregisterAgent(_agentId: string): void {}

// ── OTel events ───────────────────────────────────────────────────────────
/** User prompts were redacted unless prompt logging was on. Nothing is
 *  logged, so the honest answer is the redaction. */
export function redactIfDisabled(_content: string): string {
  return "<REDACTED>";
}
export async function logOTelEvent(
  _eventName: string,
  _metadata: { [key: string]: string | undefined } = {},
): Promise<void> {}

// ── Plugin telemetry fields ───────────────────────────────────────────────
export function buildPluginTelemetryFields(
  ..._args: unknown[]
): Record<string, string> {
  return {};
}
export function buildPluginCommandTelemetryFields(
  ..._args: unknown[]
): Record<string, string> {
  return {};
}
