/**
 * Extending the sandbox image: the tag has to be a function of the recipe.
 *
 * A chat cannot install gcc for itself — the container runs with --rm, so
 * anything apt puts there dies with it. The durable place is the image, and the
 * safe way to change an image is a LAYER on top of the base, tagged by a hash
 * of its own Containerfile.
 *
 * That hash is doing three jobs at once, and each is a way this can go wrong:
 * rebuild exactly when the recipe changes (not on every edit, not never), come
 * back instantly to a set that was built before (tick Rust, untick Rust), and
 * never touch the base — so a Containerfile line that does not build leaves
 * every chat still working.
 *
 *   npm run smoke:image
 */

import {
  BASE_IMAGE_TAG,
  IMAGE_CATEGORIES,
  IMAGE_PRESETS,
  describeExtras,
  extrasContainerfile,
  hasExtras,
  imageTagFor,
  type ImageExtras,
} from "../src/main/sandbox/image-extras.js";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : ` — ${detail}`}`,
  );
}

const extras = (presets: string[], extra = ""): ImageExtras => ({ presets, extra });
const NONE = extras([]);
const RUST = extras(["rust"]);
const CPP = extras(["cpp"]);

// ── Nothing added: the base, untouched ────────────────────────────────

check("an empty set is not an extension", !hasExtras(NONE));
check("…and builds nothing", extrasContainerfile(NONE) === "");
check("…so runs use the base image itself", imageTagFor(NONE) === BASE_IMAGE_TAG);
check(
  "whitespace is not a recipe either",
  imageTagFor(extras([], "   \n  ")) === BASE_IMAGE_TAG,
);

// ── The tag follows the recipe ────────────────────────────────────────

check("adding a toolchain changes the tag", imageTagFor(RUST) !== BASE_IMAGE_TAG);
check(
  "the same set always gives the same tag — otherwise every run rebuilds",
  imageTagFor(RUST) === imageTagFor(extras(["rust"])),
  imageTagFor(RUST),
);
check(
  "different sets give different tags",
  imageTagFor(RUST) !== imageTagFor(CPP),
);
check(
  "…and so do different hand-written lines",
  imageTagFor(extras([], "RUN echo a")) !== imageTagFor(extras([], "RUN echo b")),
);
check(
  "GOING BACK IS FREE: the old tag returns, and its image was never deleted",
  imageTagFor(extras(["rust", "cpp"])) === imageTagFor(extras(["rust", "cpp"])) &&
    imageTagFor(extras(["rust"])) === imageTagFor(RUST),
);
check(
  "order is part of the recipe — a later line may depend on an earlier one",
  imageTagFor(extras(["rust", "cpp"])) !== imageTagFor(extras(["cpp", "rust"])),
);

// ── The tag is something podman will accept ───────────────────────────
//
// [A-Za-z0-9_][A-Za-z0-9._-]{0,127} after the colon. A '+' — the obvious
// separator for "base plus extras" — is not in it, and podman rejects it.

for (const x of [NONE, RUST, extras(["rust", "cpp"], "RUN echo hi")]) {
  const tag = imageTagFor(x);
  const [name, version] = tag.split(":");
  check(
    `a valid podman tag: ${tag}`,
    /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(version ?? "") && !!name,
    tag,
  );
}

// ── The layer is a layer ──────────────────────────────────────────────

{
  const file = extrasContainerfile(extras(["rust", "cpp"], "RUN cargo install ripgrep"));
  const froms = file.split("\n").filter((l) => l.trim().startsWith("FROM"));
  check("exactly one FROM", froms.length === 1, froms.join(" | "));
  check("…and it is the base image", froms[0] === `FROM ${BASE_IMAGE_TAG}`, froms[0]);
  check(
    "presets come before hand-written lines, which usually depend on them",
    file.indexOf("rustup") < file.indexOf("cargo install ripgrep"),
  );
  check("the working directory is restored at the end", file.trimEnd().endsWith("WORKDIR /work"));
  check(
    "the recipe never reaches for the build context — it is an empty directory",
    !/^\s*(COPY|ADD)\s/m.test(file) && !/(^|\s)[A-Za-z]:[\\/]/.test(file),
  );
}

// ── Presets are self-describing ───────────────────────────────────────

check("there is a list to pick from", IMAGE_PRESETS.length >= 12);
check(
  "every entry is on a known shelf",
  IMAGE_PRESETS.every((p) => (IMAGE_CATEGORIES as readonly string[]).includes(p.category)),
  [...new Set(IMAGE_PRESETS.map((p) => p.category))].join(", "),
);
check(
  "every shelf has something on it — an empty heading is a bug in the list",
  IMAGE_CATEGORIES.every((c) => IMAGE_PRESETS.some((p) => p.category === c)),
);
check(
  "entries of one category are adjacent, so the UI groups without sorting",
  (() => {
    const seen: string[] = [];
    for (const p of IMAGE_PRESETS)
      if (seen[seen.length - 1] !== p.category) {
        if (seen.includes(p.category)) return false;
        seen.push(p.category);
      }
    return true;
  })(),
);
// Anything pip can install has no business in an image: it would be baked into
// every chat's layer for something that installs in seconds, shared, on demand.
//
// One exception, and it has to stay ONE: playwright's Python binding must match
// the Chromium build sitting beside it in the same layer. Installed later
// through the shared pip layer it drifts, which is the exact failure the `pdf`
// skill's setup.sh has a whole section for ("NODE.JS AND PYTHON PLAYWRIGHT
// VERSION MISMATCH"). A pip line anywhere else is a package that belongs in
// the shared layer instead.
{
  const withPip = IMAGE_PRESETS.filter((p) =>
    p.lines.some((l) => /\bpip install\b/.test(l)),
  );
  check(
    "pip appears in one entry only — everything else belongs in the shared layer",
    withPip.length <= 1,
    withPip.map((p) => p.id).join(", "),
  );
  check(
    "…and it is the browser, whose binding is version-locked to its Chromium",
    withPip.every(
      (p) =>
        p.id === "chromium" &&
        p.lines.some((l) => /playwright install/.test(l)),
    ),
  );
}
check(
  "nothing pulls a package index without cleaning up after itself",
  IMAGE_PRESETS.every(
    (p) =>
      !p.lines.some((l) => /apt-get update/.test(l)) ||
      p.lines.some((l) => /rm -rf \/var\/lib\/apt\/lists/.test(l)),
  ),
);
// The installable ones. Built-ins are covered separately below: they have no
// size to warn about and no lines to run, which is the point of them.
const ADDABLE = IMAGE_PRESETS.filter((p) => !p.builtin);

check(
  "every entry you can add has a size to show before a multi-minute build",
  ADDABLE.every((p) => /\d/.test(p.size)),
  ADDABLE.filter((p) => !/\d/.test(p.size)).map((p) => p.id).join(", "),
);
check(
  "every preset says what it provides, so a tool result can name it",
  IMAGE_PRESETS.every((p) => p.provides.trim().length > 0),
);
check(
  "every entry you can add is at least one Containerfile instruction",
  ADDABLE.every((p) => p.lines.some((l) => /^(RUN|ENV|ARG)\b/.test(l))),
  ADDABLE.filter((p) => !p.lines.some((l) => /^(RUN|ENV|ARG)\b/.test(l)))
    .map((p) => p.id)
    .join(", "),
);
check(
  "preset ids are unique — the tag would be ambiguous otherwise",
  new Set(IMAGE_PRESETS.map((p) => p.id)).size === IMAGE_PRESETS.length,
);
check(
  "an unknown preset id contributes nothing",
  imageTagFor(extras(["nope-not-a-preset"])) === BASE_IMAGE_TAG,
);

// ── What the base image already has ───────────────────────────────────
//
// Listed so the list can answer "what is already there" — a catalogue of
// things to add, silent about what is present, is what gets pandas installed
// into a layer for the third time. But they must behave as decoration: ticking
// one cannot produce a layer, a tag, or a rebuild that installs nothing.
{
  const builtins = IMAGE_PRESETS.filter((p) => p.builtin);
  check("the base image's contents are on the list", builtins.length >= 4);
  check(
    "…and none of them builds anything",
    builtins.every((p) => p.lines.length === 0),
    builtins.map((p) => p.id).join(", "),
  );
  check(
    "ticking one changes NOTHING — it is already in the image",
    imageTagFor(extras(builtins.map((p) => p.id))) === BASE_IMAGE_TAG,
  );
  check(
    "…and mixed with a real one, only the real one counts",
    imageTagFor(extras([...builtins.map((p) => p.id), "rust"])) ===
      imageTagFor(extras(["rust"])),
  );
  check(
    "a built-in never reaches a Containerfile",
    !extrasContainerfile(extras([...builtins.map((p) => p.id), "rust"])).includes(
      "included",
    ),
  );
  check(
    "every built-in still says what it provides, like the rest",
    builtins.every((p) => p.provides.trim().length > 0),
  );
}
check(
  "…even mixed in with a real one",
  imageTagFor(extras(["rust", "nope"])) === imageTagFor(RUST),
);

// ── What the confirmation dialog will say ─────────────────────────────

{
  const lines = describeExtras(extras(["rust"], "RUN echo hi"));
  check("the description names the toolchain", lines.some((l) => /Rust/i.test(l)), lines.join("; "));
  check("…with its size", lines.some((l) => /MB|GB/i.test(l)), lines.join("; "));
  check("…and mentions the hand-written lines", lines.length === 2, lines.join("; "));
  check("nothing added, nothing to describe", describeExtras(NONE).length === 0);
}

console.log(
  failures
    ? `\n${failures} FAILURES`
    : "\nTHE TAG IS THE RECIPE — REBUILD WHEN IT CHANGES, COME BACK FREE",
);
process.exit(failures ? 1 : 0);
