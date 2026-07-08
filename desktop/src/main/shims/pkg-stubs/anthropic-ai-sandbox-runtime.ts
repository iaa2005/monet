/**
 * STUB for '@anthropic-ai/sandbox-runtime' — package is Anthropic-internal, cloud-provider or
 * native-only; the desktop build never takes these code paths.
 * Function calls return undefined so feature checks (isXEnabled(),
 * isSupported()) read as disabled; constructing a class throws loudly
 * because a fake client must not silently exist.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const stubFn: any = new Proxy(function stubbed() {}, {
  get: (t: any, p: any) => (p in t ? t[p] : stubFn),
  apply: () => undefined,
  construct: () => { throw new Error('stubbed package: @anthropic-ai/sandbox-runtime') },
})

export const FsReadRestrictionConfig: any = stubFn
export type FsReadRestrictionConfig = any
export const FsWriteRestrictionConfig: any = stubFn
export type FsWriteRestrictionConfig = any
export const IgnoreViolationsConfig: any = stubFn
export type IgnoreViolationsConfig = any
export const NetworkHostPattern: any = stubFn
export type NetworkHostPattern = any
export const NetworkRestrictionConfig: any = stubFn
export type NetworkRestrictionConfig = any
export const SandboxAskCallback: any = stubFn
export type SandboxAskCallback = any
export const SandboxDependencyCheck: any = stubFn
export type SandboxDependencyCheck = any
export const SandboxManager: any = stubFn
export type SandboxManager = any
export const SandboxRuntimeConfig: any = stubFn
export type SandboxRuntimeConfig = any
export const SandboxRuntimeConfigSchema: any = stubFn
export type SandboxRuntimeConfigSchema = any
export const SandboxViolationEvent: any = stubFn
export type SandboxViolationEvent = any
export const SandboxViolationStore: any = stubFn
export type SandboxViolationStore = any
export default stubFn
