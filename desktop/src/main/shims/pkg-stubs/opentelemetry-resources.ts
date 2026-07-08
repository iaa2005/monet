/**
 * STUB for '@opentelemetry/resources' — package is Anthropic-internal, cloud-provider or
 * native-only; the desktop build never takes these code paths.
 * Function calls return undefined so feature checks (isXEnabled(),
 * isSupported()) read as disabled; constructing a class throws loudly
 * because a fake client must not silently exist.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const stubFn: any = new Proxy(function stubbed() {}, {
  get: (t: any, p: any) => (p in t ? t[p] : stubFn),
  apply: () => undefined,
  construct: () => { throw new Error('stubbed package: @opentelemetry/resources') },
})

export const envDetector: any = stubFn
export type envDetector = any
export const hostDetector: any = stubFn
export type hostDetector = any
export const osDetector: any = stubFn
export type osDetector = any
export const resourceFromAttributes: any = stubFn
export type resourceFromAttributes = any
export default stubFn
