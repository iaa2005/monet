/**
 * Icon resolver — a filename or folder name in, an icon URL out.
 *
 * The tables are no longer ours. flow's own mapping ships with the pack as
 * icons.json and covers 1068 extensions, 2053 whole filenames and 1178 folder
 * names; scripts/import-flow.mjs turns it into flow-map.generated.ts. Keeping
 * our older hand-written tables alongside would have been worse than deleting
 * them — 301 of their keys overlapped, so wherever the two disagreed the older
 * answer would have won.
 *
 * What stayed is in icon-overrides.ts: the suffix patterns we generalise from
 * (.test.ts, .stories.tsx) and the colour folders flow has no notion of. Those
 * win over the pack.
 */

import { FLOW_EXT, FLOW_NAMES, FLOW_FOLDERS } from "@/components/flow-map.generated";
import { OURS_EXT, OURS_FOLDERS } from "@/components/icon-overrides";

const DOC_NAMES: Record<string, string> = {
  readme: "readme",
  license: "license",
  licence: "license",
  changelog: "changelog",
  contributing: "contributing",
  authors: "authors",
  security: "security",
  code_of_conduct: "code-of-conduct",
};

/** ...and the extensions a document is actually written in. */
const DOC_EXT = new Set(["md", "markdown", "txt", "rst", "adoc", ""]);

/**
 * Config stems, matched whatever the file is written in: `vite.config.ts`,
 * `vite.config.mjs`. The dot inside the stem is what makes them unambiguous —
 * nothing is called `next.config.svg`.
 */
const CONFIG_STEMS: Record<string, string> = {
  "vite.config": "vite",
  "next.config": "next",
  "nuxt.config": "nuxt",
  "astro.config": "astro-config",
  "tailwind.config": "tailwindcss",
  "drizzle.config": "drizzle-orm",
};

/** The two tables as one lookup. Kept separate above only so the second one can
 * carry the story of why it exists. */
/** Ours last: an override is only written when flow has no answer, so this
 * order matters only for the handful of keys we deliberately shadow. */
const ALL_EXT: Record<string, string> = { ...FLOW_EXT, ...FLOW_NAMES, ...OURS_EXT };
const ALL_FOLDERS: Record<string, string> = { ...FLOW_FOLDERS, ...OURS_FOLDERS };

function iconName(name: string, isDir: boolean, open: boolean): string {
  if (isDir) {
    const key = name.toLowerCase();
    const mapped = ALL_FOLDERS[key];
    return mapped
      ? open
        ? mapped + "_open"
        : mapped
      : open
        ? "_folder_open"
        : "_folder";
  }

  const lower = name.toLowerCase();

  // Most specific first. The extension used to be tried before anything else,
  // so `Cargo.toml` resolved as toml, `package.json` as json and `types.d.ts`
  // as ts — and the map's own `tsconfig.json`, `vite.config`, `readme`,
  // `license` and `changelog` keys were unreachable by any filename.
  //
  // But "most specific" is not "longest match", and the first version of this
  // got that wrong in the other direction: it consulted the WHOLE map for the
  // stem, so `bash.svg` came out as bash, `c.svg` as C and `css.svg` as CSS.
  // Those are pictures. The map holds names of TYPES (bash, c, css) alongside
  // names of FILES (readme, license), and only the second kind may outrank an
  // extension — see DOC_NAMES and CONFIG_STEMS.

  // 1. The whole name: `package.json`, `go.mod`, `Makefile`, `CODEOWNERS`.
  const whole = ALL_EXT[lower];
  if (whole) return whole;

  // 2. A dotted tail: `.d.ts`, `.test.ts`, `.stories.tsx`, `.code-workspace`.
  for (const [pattern, icon] of Object.entries(ALL_EXT))
    if (pattern.startsWith(".") && lower.endsWith(pattern)) return icon;

  const dot = lower.lastIndexOf(".");
  const stem = dot > 0 ? lower.slice(0, dot) : lower;
  const ext = dot > 0 ? lower.slice(dot + 1) : "";

  // 3. A config stem, whatever it is written in: `vite.config.ts`,
  //    `next.config.mjs`. The dot inside the stem makes these unmistakable.
  const config = CONFIG_STEMS[stem];
  if (config) return config;

  // 4. A document name — but only with an extension a document is written in.
  //    This is the line that keeps `changelog.svg` a picture while
  //    `CHANGELOG.md` is a changelog.
  const doc = DOC_NAMES[stem];
  if (doc && DOC_EXT.has(ext)) return doc;

  // 5. The extension itself. Guarded against an empty key: a file with no
  //    extension must not look one up, and a blank entry in the pack's data
  //    once made every such file resolve to opentofu. An unknown one gets flow's `document` rather than
  //    the old `_file`: the rest of the set is flow's drawing, and the one icon
  //    an unrecognised file was guaranteed to get was the one in the other
  //    style. `_file` stays as the last resort in fallbackIcon, where it stands
  //    for "the mapped icon has no file behind it" — a different failure.
  return (ext ? ALL_EXT[ext] : undefined) ?? UNKNOWN_FILE;
}

/** What an unrecognised extension gets. flow's own generic document. */
const UNKNOWN_FILE = "document";

export function resolveIcon(
  name: string,
  isDir: boolean,
  open: boolean,
  dark: boolean,
): string {
  const base = iconName(name, isDir, open);
  const theme = dark ? "light" : "base";
  return `./icons/${theme}/${base}.svg`;
}

/** The generic icon, for when a mapped name has no file behind it. */
export function fallbackIcon(
  isDir: boolean,
  open: boolean,
  dark: boolean,
): string {
  const theme = dark ? "light" : "base";
  const base = isDir ? (open ? "_folder_open" : "_folder") : "_file";
  return `./icons/${theme}/${base}.svg`;
}

/** Every icon name the maps can produce — for the check that they all exist. */
export function allMappedIconNames(): string[] {
  const names = new Set<string>([
    "_file",
    "_folder",
    "_folder_open",
    UNKNOWN_FILE,
    ...Object.values(ALL_EXT),
    // These two were missing, so every icon reached only through a document
    // name or a config stem looked unreachable.
    ...Object.values(DOC_NAMES),
    ...Object.values(CONFIG_STEMS),
  ]);
  for (const folder of Object.values(ALL_FOLDERS)) {
    names.add(folder);
    names.add(`${folder}_open`);
  }
  return [...names];
}
