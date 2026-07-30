/**
 * Reduce our hand-written icon tables to the part flow does not cover.
 *
 * Keeping them whole would be worse than deleting them: 349 of our extension
 * keys overlap flow's, and ours were written for the older set, so wherever the
 * two disagree the older answer would win. Keeping none would lose the things
 * that are genuinely ours — the dotted-tail patterns we match by suffix where
 * flow enumerates whole filenames, and the colour folders it has no notion of.
 *
 * So: emit exactly the keys flow's map has no answer for, pointing at whatever
 * they pointed at before. Run once; after that the file is edited by hand like
 * any other, because what is in it is our own.
 */

import { readFileSync, writeFileSync } from "fs";

const RESOLVER = "src/renderer/components/icon-resolver.ts";
const GENERATED = "src/renderer/components/flow-map.generated.ts";
const OUT = "src/renderer/components/icon-overrides.ts";

const src = readFileSync(RESOLVER, "utf-8");
const gen = readFileSync(GENERATED, "utf-8");

/** Pull `const NAME: Record<…> = { … }` out of a source file as pairs. */
function table(text, name) {
  const i = text.indexOf(`const ${name}`);
  if (i < 0) return [];
  const j = text.indexOf("\n};", i);
  const body = text.slice(i, j);
  return [...body.matchAll(/^\s*"?([^":\s]+)"?:\s*"([^"]+)",/gm)].map((m) => [
    m[1].toLowerCase(),
    m[2],
  ]);
}

const flowExt = new Map(table(gen, "FLOW_EXT"));
const flowNames = new Map(table(gen, "FLOW_NAMES"));
const flowFolders = new Map(table(gen, "FLOW_FOLDERS"));

const ourExt = [
  ...table(src, "EXT_MAP"),
  ...table(src, "MORE_EXT"),
  ...table(src, "FLOW_EXT"),
];
const ourFolders = [...table(src, "FOLDER_MAP"), ...table(src, "FLOW_FOLDERS")];

// A key flow answers is a key we stop answering. Both of flow's file tables
// count: it lists `go.mod` as a whole filename where we listed it as a key.
const keptExt = ourExt.filter(([k]) => !flowExt.has(k) && !flowNames.has(k));
const keptFolders = ourFolders.filter(([k]) => !flowFolders.has(k));

const dedupe = (pairs) => {
  const m = new Map();
  for (const [k, v] of pairs) if (!m.has(k)) m.set(k, v);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
};

const record = (pairs) =>
  `{\n${pairs.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}\n}`;

const ext = dedupe(keptExt);
const folders = dedupe(keptFolders);

writeFileSync(
  OUT,
  `/**
 * Our own icon rules — the part flow's mapping has no answer for.
 *
 * Extracted once from the tables this project maintained before the flow pack
 * arrived, then kept by hand. Two kinds live here and both are deliberate:
 *
 *  • suffix patterns. We match \`.test.ts\` and \`.stories.tsx\` by their tail,
 *    where flow enumerates every whole filename it knows. Ours generalises to
 *    a file it has never seen; theirs does not.
 *  • colour folders. A folder literally named \`blue\` or \`green\` takes that
 *    colour. flow has no such notion, and it is a small thing people like.
 *
 * These win over flow's map, so anything added here shadows the pack. Add
 * sparingly, and prefer fixing the pack's own name when there is one.
 */

/** Extensions and whole filenames flow does not map. */
export const OURS_EXT: Record<string, string> = ${record(ext)};

/** Folder names flow does not map. */
export const OURS_FOLDERS: Record<string, string> = ${record(folders)};
`,
);

console.log(`ours that survive flow's mapping:`);
console.log(`  ${ext.length} extension/filename keys`);
console.log(`  ${folders.length} folder keys`);
console.log(`dropped as covered by flow:`);
console.log(`  ${ourExt.length - keptExt.length} extension keys`);
console.log(`  ${ourFolders.length - keptFolders.length} folder keys`);
console.log(`wrote ${OUT}`);
