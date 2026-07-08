/**
 * Ambient augmentations for the vendor (leaked) tree.
 *
 * react/compiler-runtime: vendor sources are React-Compiler-compiled and
 * import { c } — @types/react deliberately declares no exports for it.
 */
declare module 'react/compiler-runtime' {
  export function c(size: number): unknown[]
}
