/**
 * One latest-mac.yml for both Mac architectures.
 *
 *   node scripts/merge-mac-manifest.mjs <out.yml> <a.yml> <b.yml> [...]
 *
 * The Apple-silicon and Intel builds run on different machines, and each
 * electron-builder writes a latest-mac.yml naming only the zip it built.
 * Whichever uploads last wins, and the updater on the other kind of Mac
 * then finds no file for itself — or worse, takes the wrong one. This
 * puts every file from every manifest into one, the way a single build of
 * both architectures would have written it: `files` carries both zips,
 * and the top-level `path`/`sha512` (what old updaters read) points at the
 * arm64 one when there is one.
 *
 * The manifests are flat enough to read without a YAML library, which the
 * runner does not have installed.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [out, ...inputs] = process.argv.slice(2);
if (!out || inputs.length === 0) {
  console.error("usage: merge-mac-manifest.mjs <out.yml> <in.yml> [...]");
  process.exit(2);
}

/** `files:` entries of one manifest: {url, sha512, size}. */
function entries(text) {
  const found = [];
  const block = /^files:\n((?:  .*\n?)+)/m.exec(text)?.[1] ?? "";
  for (const item of block.split(/^  - /m).slice(1)) {
    const get = (k) => new RegExp(`^\\s*${k}:\\s*(.+)$`, "m").exec(item)?.[1]?.trim();
    const url = get("url");
    if (url) found.push({ url, sha512: get("sha512"), size: get("size") });
  }
  return found;
}

const texts = inputs.map((p) => readFileSync(p, "utf8"));
const version = /^version:\s*(.+)$/m.exec(texts[0])?.[1]?.trim();
if (!version) {
  console.error(`no version in ${inputs[0]}`);
  process.exit(1);
}
for (const [i, t] of texts.entries()) {
  const v = /^version:\s*(.+)$/m.exec(t)?.[1]?.trim();
  if (v !== version) {
    console.error(`${inputs[i]} is version ${v}, not ${version}`);
    process.exit(1);
  }
}

const byUrl = new Map();
for (const t of texts) for (const e of entries(t)) byUrl.set(e.url, e);
const files = [...byUrl.values()];
if (files.length === 0) {
  console.error("no files in any manifest");
  process.exit(1);
}
const primary = files.find((f) => /arm64/.test(f.url)) ?? files[0];

const yml = [
  `version: ${version}`,
  "files:",
  ...files.flatMap((f) => [
    `  - url: ${f.url}`,
    `    sha512: ${f.sha512}`,
    `    size: ${f.size}`,
  ]),
  `path: ${primary.url}`,
  `sha512: ${primary.sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  "",
].join("\n");
writeFileSync(out, yml);
console.log(`${out}: ${files.map((f) => f.url).join(", ")}`);
