/**
 * LaTeX (and the rest Monaco does not ship) really are coloured.
 *
 * Run against the app — `npx electron-vite dev -- --remote-debugging-port=9222`.
 * A unit test can only prove the tokenizer emits tokens; what matters is that
 * MONACO ends up with them: that `.tex` resolves to a language rather than
 * plaintext, that its tokens carry scopes the theme paints, and that the
 * comment in line three is a comment.
 */
import { WebSocket } from "ws";

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.title.includes("Code Monet"));
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on("open", r));
let id = 0;
const pending = new Map();
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.id && pending.has(m.id)) pending.get(m.id)(m);
});
const evalJs = (expression) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, (m) =>
      res(
        m.result?.exceptionDetails
          ? { thrown: m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text }
          : m.result?.result?.value,
      ),
    );
    ws.send(
      JSON.stringify({
        id: i,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });

// A fresh page: languages are registered once per page, so a stale
// registration from a previous edit would answer for the current code.
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  if ((await evalJs(`document.readyState === "complete"`)) === true) break;
}
await new Promise((r) => setTimeout(r, 1500));

const out = await evalJs(`(async () => {
  // Importing the app's editor module is what pulls monaco in; until then
  // the page has no monaco to ask.
  const { languageOf } = await import("/components/monaco-langs.ts");
  const { configureMonaco } = await import("/components/monaco-project.ts");
  configureMonaco();
  const depUrl = performance
    .getEntriesByType("resource")
    .map((e) => e.name)
    .find((n) => n.includes("deps/monaco-editor.js"));
  if (!depUrl) return { error: "monaco not loaded in the page" };
  const monaco = await import(depUrl);

  const scopesOf = (text, lang) =>
    monaco.editor
      .tokenize(text, lang)
      .flat()
      .map((t) => t.type)
      .filter(Boolean);

  const tex = [
    "% a comment",
    "\\\\documentclass{article}",
    "\\\\begin{document}",
    "Let $E = mc^2$ hold.",
    "\\\\end{document}",
  ].join("\\n");

  return {
    langOfTex: languageOf("paper.tex"),
    langOfBib: languageOf("refs.bib"),
    langOfToml: languageOf("Cargo.toml"),
    langOfDiff: languageOf("fix.patch"),
    langOfUnknown: languageOf("mystery.qqq"),
    // Monaco's own languages must not be taken over.
    langOfTs: languageOf("index.ts"),
    texScopes: scopesOf(tex, "latex"),
    tomlScopes: scopesOf('# c\\nname = "monet"\\nport = 8080\\n', "toml"),
    plainScopes: scopesOf(tex, "plaintext"),
  };
})()`);

ws.close();

if (out?.thrown || out?.error) {
  console.error(JSON.stringify(out, null, 2));
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

const has = (scopes, want) => (scopes ?? []).some((s) => s.startsWith(want));

check("a .tex file is LaTeX, not plain text", out.langOfTex === "latex", out.langOfTex);
check("and so are .bib files", out.langOfBib === "latex", out.langOfBib);
check(".toml is TOML", out.langOfToml === "toml", out.langOfToml);
check(".patch is a diff", out.langOfDiff === "diff", out.langOfDiff);
check("an unknown extension is still plain text", out.langOfUnknown === "plaintext", out.langOfUnknown);
check("Monaco's own languages are untouched", out.langOfTs === "typescript", out.langOfTs);
check("a LaTeX comment is a comment", has(out.texScopes, "comment"), out.texScopes?.slice(0, 6));
check("its commands are keywords", has(out.texScopes, "keyword"));
check("and its maths is not plain", has(out.texScopes, "string"));
check("TOML colours keys and values apart", has(out.tomlScopes, "attribute.name") && has(out.tomlScopes, "string"), out.tomlScopes);
check(
  "plain text stays plain (the tokens are ours, not everyone's)",
  (out.plainScopes ?? []).every((s) => s === "" || s.startsWith("source")),
  out.plainScopes?.slice(0, 4),
);

console.log(failures === 0 ? "\nALL LANGUAGE CHECKS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
