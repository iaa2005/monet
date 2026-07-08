/**
 * STUB for '@ant/' — package is Anthropic-internal, cloud-provider or
 * native-only; the desktop build never takes these code paths.
 * Function calls return undefined so feature checks (isXEnabled(),
 * isSupported()) read as disabled; constructing a class throws loudly
 * because a fake client must not silently exist.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const stubFn: any = new Proxy(function stubbed() {}, {
  get: (t: any, p: any) => (p in t ? t[p] : stubFn),
  apply: () => undefined,
  construct: () => { throw new Error('stubbed package: @ant/') },
})

export const API_RESIZE_PARAMS: any = stubFn
export type API_RESIZE_PARAMS = any
export const BROWSER_TOOLS: any = stubFn
export type BROWSER_TOOLS = any
export const ClaudeForChromeContext: any = stubFn
export type ClaudeForChromeContext = any
export const ComputerExecutor: any = stubFn
export type ComputerExecutor = any
export const ComputerUseAPI: any = stubFn
export type ComputerUseAPI = any
export const ComputerUseHostAdapter: any = stubFn
export type ComputerUseHostAdapter = any
export const ComputerUseInput: any = stubFn
export type ComputerUseInput = any
export const ComputerUseInputAPI: any = stubFn
export type ComputerUseInputAPI = any
export const ComputerUseSessionContext: any = stubFn
export type ComputerUseSessionContext = any
export const CoordinateMode: any = stubFn
export type CoordinateMode = any
export const CuCallToolResult: any = stubFn
export type CuCallToolResult = any
export const CuPermissionRequest: any = stubFn
export type CuPermissionRequest = any
export const CuPermissionResponse: any = stubFn
export type CuPermissionResponse = any
export const CuSubGates: any = stubFn
export type CuSubGates = any
export const DEFAULT_GRANT_FLAGS: any = stubFn
export type DEFAULT_GRANT_FLAGS = any
export const DisplayGeometry: any = stubFn
export type DisplayGeometry = any
export const FrontmostApp: any = stubFn
export type FrontmostApp = any
export const InstalledApp: any = stubFn
export type InstalledApp = any
export const Logger: any = stubFn
export type Logger = any
export const PermissionMode: any = stubFn
export type PermissionMode = any
export const ResolvePrepareCaptureResult: any = stubFn
export type ResolvePrepareCaptureResult = any
export const RunningApp: any = stubFn
export type RunningApp = any
export const ScreenshotDims: any = stubFn
export type ScreenshotDims = any
export const ScreenshotResult: any = stubFn
export type ScreenshotResult = any
export const bindSessionContext: any = stubFn
export type bindSessionContext = any
export const buildComputerUseTools: any = stubFn
export type buildComputerUseTools = any
export const createClaudeForChromeMcpServer: any = stubFn
export type createClaudeForChromeMcpServer = any
export const createComputerUseMcpServer: any = stubFn
export type createComputerUseMcpServer = any
export const targetImageSize: any = stubFn
export type targetImageSize = any
export default stubFn
