/**
 * STUB for '@opentelemetry/sdk-metrics' — package is Anthropic-internal, cloud-provider or
 * native-only; the desktop build never takes these code paths.
 * Function calls return undefined so feature checks (isXEnabled(),
 * isSupported()) read as disabled; constructing a class throws loudly
 * because a fake client must not silently exist.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const stubFn: any = new Proxy(function stubbed() {}, {
  get: (t: any, p: any) => (p in t ? t[p] : stubFn),
  apply: () => undefined,
  construct: () => { throw new Error('stubbed package: @opentelemetry/sdk-metrics') },
})

export const AggregationTemporality: any = stubFn
export type AggregationTemporality = any
export const ConsoleMetricExporter: any = stubFn
export type ConsoleMetricExporter = any
export const DataPoint: any = stubFn
export type DataPoint = any
export const MeterProvider: any = stubFn
export type MeterProvider = any
export const MetricData: any = stubFn
export type MetricData = any
export const PeriodicExportingMetricReader: any = stubFn
export type PeriodicExportingMetricReader = any
export const PushMetricExporter: any = stubFn
export type PushMetricExporter = any
export const ResourceMetrics: any = stubFn
export type ResourceMetrics = any
export default stubFn
