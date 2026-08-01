/**
 * Monaco's editor worker, as a module of ours.
 *
 * Vite can turn a bare `monaco-editor/...?worker` import into a worker, but
 * not through this project's resolver (the renderer aliases a lot). A local
 * file that simply re-exports it is resolved like any other source file, and
 * `new URL(..., import.meta.url)` gives Vite the anchor it needs.
 *
 * Only the base editor worker: the viewer shows files, it does not need the
 * language services (JSON schema validation, TypeScript IntelliSense) that
 * would each pull in a worker of their own.
 */
import "monaco-editor/editor/editor.worker";
