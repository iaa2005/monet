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
/**
 * SandboxManager needs one real method.
 *
 * BashTool passes a failing command's ENTIRE output through
 * annotateStderrWithSandboxFailures() before putting it in the ShellError it
 * throws. With the blanket stub returning undefined, every non-zero exit — a
 * red pytest, a grep with no match, a diff with differences — arrived with its
 * output erased, so the model could not tell a failing command from a broken
 * tool. There are no sandbox violations to annotate here, so the honest
 * behaviour is to hand the output back untouched.
 */
export const SandboxManager: any = new Proxy(stubFn, {
  get: (t: any, p: any) =>
    p === "annotateStderrWithSandboxFailures"
      ? (_command: string, stderr: string) => stderr ?? ""
      : p in t
        ? t[p]
        : stubFn,
})
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
