/**
 * The TypeScript language service, in its own worker.
 *
 * The base editor worker cannot answer a completion request — it replies
 * "Missing requestHandler or method: getCompletionsAtPosition", which is what
 * IntelliSense looked like before this file existed. TS/JS models must be
 * pointed at THIS worker (see CodeEditor's MonacoEnvironment.getWorker, which
 * switches on the label Monaco passes it).
 *
 * 0.56 ships the service twice: the old `language/typescript` path and the new
 * `languages/features/typescript` one. The new one is what `monaco.typescript`
 * (the top-level namespace) drives, so it is the one that must be here.
 */
import "monaco-editor/languages/features/typescript/ts.worker";
