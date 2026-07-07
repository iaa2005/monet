// Shim for color-diff-napi
export class ColorDiff {}
export class ColorFile {}
export function getSyntaxTheme(): SyntaxTheme { return {} as SyntaxTheme; }
export type SyntaxTheme = Record<string, any>;
export default { ColorDiff, ColorFile, getSyntaxTheme };
