/**
 * STUB for '@opentelemetry/semantic-conventions' — package is Anthropic-internal, cloud-provider or
 * native-only; the desktop build never takes these code paths.
 * Function calls return undefined so feature checks (isXEnabled(),
 * isSupported()) read as disabled; constructing a class throws loudly
 * because a fake client must not silently exist.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const stubFn: any = new Proxy(function stubbed() {}, {
  get: (t: any, p: any) => (p in t ? t[p] : stubFn),
  apply: () => undefined,
  construct: () => { throw new Error('stubbed package: @opentelemetry/semantic-conventions') },
})

export const ATTR_SERVICE_NAME: any = stubFn
export type ATTR_SERVICE_NAME = any
export const ATTR_SERVICE_VERSION: any = stubFn
export type ATTR_SERVICE_VERSION = any
export const SEMRESATTRS_HOST_ARCH: any = stubFn
export type SEMRESATTRS_HOST_ARCH = any
export default stubFn
