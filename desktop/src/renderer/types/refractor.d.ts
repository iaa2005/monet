/**
 * refractor@3 ships no types and we only touch a tiny, stable slice of its API
 * (highlight + registered). The return of `highlight` is a hast fragment whose
 * exact shape we normalise at the call site, so `unknown` is deliberate.
 */
declare module "refractor" {
  interface Refractor {
    highlight(value: string, language: string): unknown;
    registered(language: string): boolean;
    register(syntax: unknown): void;
  }
  const refractor: Refractor;
  export default refractor;
}
