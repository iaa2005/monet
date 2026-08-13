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

check("there are presets to tick", IMAGE_PRESETS.length >= 4);
check(
  "every preset has a size to show before a multi-minute build",
  IMAGE_PRESETS.every((p) => /\d/.test(p.size)),
);
check(
  "every preset says what it provides, so a tool result can name it",
  IMAGE_PRESETS.every((p) => p.provides.trim().length > 0),
);
check(
  "every preset is at least one Containerfile instruction",
  IMAGE_PRESETS.every((p) => p.lines.some((l) => /^(RUN|ENV|ARG)\b/.test(l))),
);
check(
  "preset ids are unique — the tag would be ambiguous otherwise",
  new Set(IMAGE_PRESETS.map((p) => p.id)).size === IMAGE_PRESETS.length,
);
check(
  "an unknown preset id contributes nothing",
  imageTagFor(extras(["nope-not-a-preset"])) === BASE_IMAGE_TAG,
);
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
