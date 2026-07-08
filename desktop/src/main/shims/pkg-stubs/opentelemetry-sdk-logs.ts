/**
 * STUB for '@opentelemetry/sdk-logs' — package is Anthropic-internal, cloud-provider or
 * native-only; the desktop build never takes these code paths.
 * Function calls return undefined so feature checks (isXEnabled(),
 * isSupported()) read as disabled; constructing a class throws loudly
 * because a fake client must not silently exist.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const stubFn: any = new Proxy(function stubbed() {}, {
  get: (t: any, p: any) => (p in t ? t[p] : stubFn),
  apply: () => undefined,
  construct: () => { throw new Error('stubbed package: @opentelemetry/sdk-logs') },
})

export const BatchLogRecordProcessor: any = stubFn
export type BatchLogRecordProcessor = any
export const ConsoleLogRecordExporter: any = stubFn
export type ConsoleLogRecordExporter = any
export const LogRecordExporter: any = stubFn
export type LogRecordExporter = any
export const LoggerProvider: any = stubFn
export type LoggerProvider = any
export const ReadableLogRecord: any = stubFn
export type ReadableLogRecord = any
export default stubFn
