/**
 * The icons are hugeicons, and they ship WITH the app.
 *
 * Two ways this breaks silently, both of them invisible in a dev run on a
 * fast network:
 *
 *   - a name that hugeicons does not have. @iconify/react does not throw on
 *     one; it asks the API for it, gets nothing, and renders an empty box.
 *   - a subset that has drifted from hg.tsx. Same ending, except the icon
 *     exists and works locally, because the dev machine's Iconify fetched it
 *     over the wire and the user's packaged app cannot.
 *
 * So: every name in hg.tsx exists in the installed collection, and the
 * shipped JSON holds exactly those names — no more (dead weight), no fewer
 * (a hole). Plus the rule that started this: lucide is gone from the app,
 * except where a mark is our own drawing and no set has it.
 *
 *   npm run smoke:hugeicons
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const collection = require("@iconify-json/hugeicons/icons.json") as {
  prefix: string;
  icons: Record<string, { body: string }>;
};

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}`);
    if (detail !== undefined) console.log("      ", JSON.stringify(detail));
  }
}

const ICONS_DIR = join("src", "renderer", "components", "icons");
const hgSrc = readFileSync(join(ICONS_DIR, "hg.tsx"), "utf-8");
const subset = JSON.parse(
  readFileSync(join(ICONS_DIR, "hugeicons-subset.json"), "utf-8"),
) as { prefix: string; icons: Record<string, unknown>; width?: number };

const used = [
  ...new Set([...hgSrc.matchAll(/hg\("([a-z0-9-]+)"\)/g)].map((m) => m[1])),
].sort();

check(`hg.tsx names ${used.length} icons`, used.length > 100, used.length);

const unknown = used.filter((n) => !collection.icons[n]);
check("every one of them exists in hugeicons", unknown.length === 0, unknown);

const shipped = Object.keys(subset.icons).sort();
check(
  "the shipped subset is exactly those names",
  shipped.length === used.length && shipped.every((n, i) => n === used[i]),
  {
    missing: used.filter((n) => !subset.icons[n]),
    extra: shipped.filter((n) => !used.includes(n)),
  },
);
check("…under the hugeicons prefix", subset.prefix === "hugeicons", subset.prefix);
check(
  "…and every body is real SVG, not a placeholder",
  shipped.every((n) => {
    const icon = subset.icons[n] as { body?: string };
    return typeof icon?.body === "string" && icon.body.includes("<");
  }),
);
check(
  "it is registered before anything renders",
  /addCollection\(\s*subset/.test(hgSrc),
);

// Nothing pulls lucide any more — one grep, because 81 files is exactly the
// scale at which one straggler is never noticed.
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : /\.tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
}
const stragglers = sources(join("src", "renderer")).filter((f) =>
  /from\s*["']lucide-react["']/.test(readFileSync(f, "utf-8")),
);
check("no file imports lucide-react", stragglers.length === 0, stragglers);

// The exceptions, on purpose: our own marks. hugeicons has python, java, cpp
// and github — it has no Go, no Rust, no Node and no Obsidian, and a row of
// languages where four are drawn and three are missing is worse than a row
// that is all ours.
check(
  "the Obsidian stone is still our own drawing",
  existsSync(join("src", "renderer", "components", "ObsidianIcon.tsx")) &&
    !/icons\/hg/.test(
      readFileSync(join("src", "renderer", "components", "ObsidianIcon.tsx"), "utf-8"),
    ),
);
check(
  "…as are the app's language marks",
  /export function RustIcon/.test(readFileSync(join(ICONS_DIR, "index.tsx"), "utf-8")),
);

// The end of the argument: render the module's own components, offline, with
// no API reachable from here, and look at what comes out. A name Iconify
// cannot resolve renders an empty <span> — which is exactly what the user
// would see, and exactly what no amount of JSON-checking above would catch.
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement } = await import("react");
const hg = (await import("../src/renderer/components/icons/hg.js")) as Record<
  string,
  unknown
>;

for (const name of ["ChevronRight", "Trash2", "Download", "X", "Search"]) {
  const Component = hg[name] as Parameters<typeof createElement>[0];
  const html = renderToStaticMarkup(
    createElement(Component, { className: "size-4" }),
  );
  check(
    `<${name}/> renders real SVG with no network`,
    html.includes("<svg") && /<(path|g|circle|rect)/.test(html),
    html.slice(0, 120),
  );
}

console.log(
  failures === 0
    ? "\nEVERY ICON THE APP DRAWS IS IN THE APP"
    : `\n${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
