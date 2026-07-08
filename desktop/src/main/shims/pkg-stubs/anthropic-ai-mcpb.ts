/**
 * STUB for '@anthropic-ai/mcpb' — package is Anthropic-internal, cloud-provider or
 * native-only; the desktop build never takes these code paths.
 * Function calls return undefined so feature checks (isXEnabled(),
 * isSupported()) read as disabled; constructing a class throws loudly
 * because a fake client must not silently exist.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const stubFn: any = new Proxy(function stubbed() {}, {
  get: (t: any, p: any) => (p in t ? t[p] : stubFn),
  apply: () => undefined,
  construct: () => { throw new Error('stubbed package: @anthropic-ai/mcpb') },
})

export const McpbManifest: any = stubFn
export type McpbManifest = any
export const McpbUserConfigurationOption: any = stubFn
export type McpbUserConfigurationOption = any
export default stubFn
