/**
 * STUB for '@opentelemetry/api-logs' — package is Anthropic-internal, cloud-provider or
 * native-only; the desktop build never takes these code paths.
 * Function calls return undefined so feature checks (isXEnabled(),
 * isSupported()) read as disabled; constructing a class throws loudly
 * because a fake client must not silently exist.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const stubFn: any = new Proxy(function stubbed() {}, {
  get: (t: any, p: any) => (p in t ? t[p] : stubFn),
  apply: () => undefined,
  construct: () => { throw new Error('stubbed package: @opentelemetry/api-logs') },
})

export const AnyValueMap: any = stubFn
export type AnyValueMap = any
export const Logger: any = stubFn
export type Logger = any
export const logs: any = stubFn
export type logs = any
export default stubFn
