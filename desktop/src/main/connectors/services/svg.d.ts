/** Vite inlines `?raw` imports as strings in the main bundle too — this makes
 * the type checker agree, so a service folder can carry its own icon.svg. */
declare module "*.svg?raw" {
  const content: string;
  export default content;
}
