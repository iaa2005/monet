/**
 * What the user added to the sandbox image, and the tag that follows from it.
 *
 * The container runs with --rm, so anything installed INSIDE one is gone when
 * it exits: `apt-get install gcc` is not a thing a chat can do for itself. The
 * only durable place is the image, and the only safe way to change an image is
 * to build a new one — a layer on top of the base:
 *
 *     FROM monet-sandbox:v3
 *     RUN apt-get install -y build-essential
 *
 * The tag carries a hash of that text, so three things come for free: the
 * rebuild happens exactly when the text changes, going back to an earlier set
 * is instant (its tag was never deleted), and the base image is never touched —
 * a Containerfile line that does not build leaves every chat still working,
 * on the base.
 *
 * Pure: no podman, no electron, no disk beyond one config file. The arithmetic
 * — hashing, tag shape, preset expansion — is what a probe pins down.
 */

import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";

/** The base image every chat runs, and the FROM of any extension. */
export const BASE_IMAGE_TAG = "monet-sandbox:v3";

/** The shelves of the list. Order is the order they are shown in. */
export const IMAGE_CATEGORIES = [
  "Languages",
  "Web",
  "Documents",
  "Media",
  "Data",
  "Tools",
] as const;
export type ImageCategory = (typeof IMAGE_CATEGORIES)[number];

export interface ImagePreset {
  id: string;
  /** What the user sees. */
  label: string;
  category: ImageCategory;
  /** Roughly how much it adds, for the confirmation dialog. */
  size: string;
  /** What it makes available, in the model's words — used in tool results. */
  provides: string;
  lines: string[];
  /**
   * Already in the base image — listed, ticked, and not up for discussion.
   *
   * These build nothing: `lines` is empty and they never reach a Containerfile
   * or the tag. They are here because the list is the only place that answers
   * "what does the sandbox already have", and a list of things you can add,
   * with no mention of what is present, invites the model and the user alike
   * to install pandas.
   */
  builtin?: boolean;
}

/** apt in one RUN, so a failure names itself in the build log rather than
 * leaving a half-updated index in a cached layer. `--no-install-recommends`
 * throughout: build-essential's recommends alone are ~300 MB of documentation
 * nobody in a sandbox will read. */
function apt(...packages: string[]): string[] {
  return [
    "RUN apt-get update \\",
    ` && apt-get install -y --no-install-recommends ${packages.join(" ")} \\`,
    " && rm -rf /var/lib/apt/lists/*",
  ];
}

/**
 * The list to pick from.
 *
 * Chosen from what a sandboxed agent actually walks into: a compiler it does
 * not have, a .docx it cannot convert, a PDF it cannot read the text out of, a
 * repository it cannot clone. Sizes are as installed, rounded — they exist so
 * nobody starts a 700 MB download by accident, not to be exact.
 *
 * Not here on purpose: anything pip can install. Those go into the shared pip
 * layer in seconds and need no image at all (see PIP_ENV_ARGS) — torch in this
 * list would be a gigabyte baked into every chat's image to no benefit.
 */
export const IMAGE_PRESETS: ImagePreset[] = [
  // ── Languages ──────────────────────────────────────────────────────
  {
    id: "python",
    label: "Python 3.12",
    category: "Languages",
    size: "included",
    provides: "python3 with numpy, pandas, matplotlib and Pillow",
    lines: [],
    builtin: true,
  },
  {
    id: "node",
    label: "Node.js",
    category: "Languages",
    size: "included",
    provides: "node, npm, npx",
    lines: [],
    builtin: true,
  },
  {
    id: "cpp",
    label: "C / C++",
    category: "Languages",
    size: "~400 MB",
    provides: "gcc, g++, make, cmake",
    lines: apt("build-essential", "cmake"),
  },
  {
    id: "rust",
    label: "Rust",
    category: "Languages",
    size: "~700 MB",
    provides: "rustc, cargo",
    lines: [
      ...apt("build-essential"),
      "RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \\",
      " | sh -s -- -y --profile minimal --no-modify-path",
      'ENV PATH="/root/.cargo/bin:${PATH}"',
    ],
  },
  {
    id: "go",
    label: "Go",
    category: "Languages",
    size: "~500 MB",
    provides: "go",
    lines: [
      "RUN curl -fsSL https://go.dev/dl/go1.23.5.linux-amd64.tar.gz \\",
      " | tar -xz -C /usr/local",
      'ENV PATH="/usr/local/go/bin:${PATH}"',
    ],
  },
  {
    id: "jdk",
    label: "Java (JDK 21)",
    category: "Languages",
    size: "~350 MB",
    provides: "java, javac",
    lines: apt("default-jdk-headless"),
  },
  // ── Web ────────────────────────────────────────────────────────────
  //
  // The single most-wanted thing in the skill catalogue. `pdf` checks for it
  // by name and calls it the HTML route, `playwright-scraper-skill` and
  // `browse` are nothing without it, `equity-research` lays its tearsheet out
  // with paged.js, and mermaid-cli renders SVG through the same browser. Big,
  // and it unlocks more skills than anything else on this list.
  {
    id: "chromium",
    label: "Headless browser",
    category: "Web",
    size: "~600 MB",
    provides:
      "playwright + headless Chromium — HTML to PDF, page screenshots, scraping a site that needs JavaScript",
    lines: [
      "RUN npm install -g playwright",
      // --with-deps is the apt half: libgbm1, libasound2, libatk-bridge2.0-0
      // and the rest. Skills that hit this list by hand are working around
      // its absence.
      "RUN npx playwright install --with-deps chromium \\",
      " && rm -rf /var/lib/apt/lists/*",
      // Both language bindings, because the skills use both.
      "RUN pip install --no-cache-dir playwright",
    ],
  },
  // ── Documents ──────────────────────────────────────────────────────
  {
    id: "pydocs",
    label: "Document libraries",
    category: "Documents",
    size: "included",
    provides: "fpdf2, python-docx, openpyxl — PDFs, .docx and .xlsx from Python",
    lines: [],
    builtin: true,
  },
  {
    id: "tectonic",
    label: "Tectonic (LaTeX)",
    category: "Documents",
    size: "included",
    provides:
      "tectonic — a self-contained XeTeX that fetches TeX packages on demand, so no texlive is needed",
    lines: [],
    builtin: true,
  },
  {
    id: "fonts",
    label: "DejaVu + Liberation fonts",
    category: "Documents",
    size: "included",
    provides: "full Latin and Cyrillic coverage in PDFs and charts",
    lines: [],
    builtin: true,
  },
  {
    id: "libreoffice",
    label: "LibreOffice",
    category: "Documents",
    size: "~800 MB",
    provides: "soffice — converts .docx/.xlsx/.pptx to PDF and between formats",
    lines: apt("libreoffice-writer", "libreoffice-calc", "libreoffice-impress"),
  },
  {
    id: "pdftools",
    label: "PDF tools",
    category: "Documents",
    size: "~150 MB",
    provides:
      "pdftotext, pdftoppm, pdfimages (poppler) and ghostscript — text out of a PDF, pages to images, compression",
    lines: apt("poppler-utils", "ghostscript"),
  },
  {
    id: "pandoc",
    label: "Pandoc",
    category: "Documents",
    size: "~200 MB",
    provides: "pandoc — markdown, HTML, docx, epub in every direction",
    lines: apt("pandoc"),
  },
  // The base image carries DejaVu and Liberation: Latin and Cyrillic, and
  // nothing else. Several report and slide skills name Noto CJK / Source Han
  // outright, and without it CJK text renders as boxes in every PDF.
  {
    id: "cjkfonts",
    label: "CJK fonts",
    category: "Documents",
    size: "~250 MB",
    provides:
      "Noto Sans/Serif CJK — Chinese, Japanese and Korean text in PDFs and images instead of empty boxes",
    lines: apt("fonts-noto-cjk", "fonts-noto-cjk-extra"),
  },
  // ── Media ──────────────────────────────────────────────────────────
  {
    id: "ffmpeg",
    label: "ffmpeg",
    category: "Media",
    size: "~250 MB",
    provides: "ffmpeg, ffprobe — audio and video, converting and cutting",
    lines: apt("ffmpeg"),
  },
  {
    id: "imagemagick",
    label: "ImageMagick",
    category: "Media",
    size: "~120 MB",
    provides: "convert, magick — batch image work Pillow makes awkward",
    lines: apt("imagemagick"),
  },
  {
    id: "tesseract",
    label: "Tesseract OCR (eng + rus)",
    category: "Media",
    size: "~180 MB",
    provides: "tesseract — text out of an image, in English and Russian",
    lines: apt("tesseract-ocr", "tesseract-ocr-eng", "tesseract-ocr-rus"),
  },
  // ── Data ───────────────────────────────────────────────────────────
  {
    id: "jupyter",
    label: "Jupyter",
    category: "Data",
    size: "included",
    provides: "notebook, nbconvert, ipykernel and plotly",
    lines: [],
    builtin: true,
  },
  {
    id: "sqlite",
    label: "SQLite CLI",
    category: "Data",
    size: "~5 MB",
    provides: "sqlite3 — Python already has the library, this is the shell",
    lines: apt("sqlite3"),
  },
  {
    id: "postgres",
    label: "PostgreSQL client",
    category: "Data",
    size: "~40 MB",
    provides: "psql, pg_dump — talk to a database elsewhere",
    lines: apt("postgresql-client"),
  },
  // ── Tools ──────────────────────────────────────────────────────────
  {
    id: "git",
    label: "Git",
    category: "Tools",
    size: "~60 MB",
    provides: "git — clone a repository into the sandbox and work in it",
    lines: apt("git", "ca-certificates"),
  },
  {
    id: "shell",
    label: "Shell utilities",
    category: "Tools",
    size: "~40 MB",
    provides: "jq, ripgrep, unzip, 7z, tree",
    lines: apt("jq", "ripgrep", "unzip", "p7zip-full", "tree"),
  },
  // Each of the three below exists because a skill in the catalogue calls the
  // binary by name and tells the user to go install it.
  {
    id: "forge-cli",
    label: "GitHub / GitLab CLI",
    category: "Tools",
    size: "~90 MB",
    provides: "gh, glab — pull requests, issues, CI from the command line",
    lines: [
      "RUN curl -fsSL https://github.com/cli/cli/releases/download/v2.63.2/gh_2.63.2_linux_amd64.tar.gz \\",
      " | tar -xz -C /tmp \\",
      " && mv /tmp/gh_2.63.2_linux_amd64/bin/gh /usr/local/bin/gh \\",
      " && rm -rf /tmp/gh_2.63.2_linux_amd64",
      "RUN curl -fsSL https://gitlab.com/gitlab-org/cli/-/releases/v1.49.0/downloads/glab_1.49.0_Linux_x86_64.tar.gz \\",
      " | tar -xz -C /tmp \\",
      " && mv /tmp/bin/glab /usr/local/bin/glab \\",
      " && rm -rf /tmp/bin",
    ],
  },
  {
    id: "kubectl",
    label: "kubectl",
    category: "Tools",
    size: "~55 MB",
    provides: "kubectl — talk to a Kubernetes cluster",
    lines: [
      "RUN curl -fsSL -o /usr/local/bin/kubectl \\",
      " https://dl.k8s.io/release/v1.31.4/bin/linux/amd64/kubectl \\",
      " && chmod +x /usr/local/bin/kubectl",
    ],
  },
  {
    id: "loadtest",
    label: "Load testing",
    category: "Tools",
    size: "~15 MB",
    provides: "wrk, ab — measure how an HTTP endpoint holds up",
    lines: apt("wrk", "apache2-utils"),
  },
];

export interface ImageExtras {
  /** Preset ids, in the order they were added. */
  presets: string[];
  /** Raw Containerfile lines the user wrote. No FROM — the layer supplies it. */
  extra: string;
}

const EMPTY: ImageExtras = { presets: [], extra: "" };

function configPath(): string {
  return join(getDataDir(), "sandbox-image.json");
}

export function getImageExtras(): ImageExtras {
  try {
    const p = configPath();
    if (!existsSync(p)) return { ...EMPTY };
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<ImageExtras>;
    return {
      // Unknown ids are dropped, not kept: a preset removed in a later build
      // must not keep a machine pinned to a tag nothing can reproduce.
      presets: Array.isArray(raw.presets)
        ? raw.presets.filter((id) =>
            IMAGE_PRESETS.some((p) => p.id === id && !p.builtin),
          )
        : [],
      extra: typeof raw.extra === "string" ? raw.extra : "",
    };
  } catch {
    return { ...EMPTY };
  }
}

export function setImageExtras(patch: Partial<ImageExtras>): ImageExtras {
  const next: ImageExtras = { ...getImageExtras(), ...patch };
  // Same filter as the reader: a caller cannot write in an id that will be
  // silently dropped on the way back out, leaving the UI showing a preset the
  // image does not have.
  next.presets = next.presets.filter((id) =>
    IMAGE_PRESETS.some((p) => p.id === id && !p.builtin),
  );
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf-8");
  } catch {
    /* best-effort, same as the engine config beside it */
  }
  return next;
}

/**
 * The presets in a set that this build actually knows.
 *
 * Every question below is asked of THIS, never of the raw list. A preset id
 * that no longer exists — dropped in a later version, or typed in by hand —
 * would otherwise count as "something was added": the set would hash to a new
 * tag and podman would build a layer consisting of FROM and WORKDIR, minutes
 * spent producing a copy of the base image under a different name.
 */
function knownPresets(x: ImageExtras): ImagePreset[] {
  return x.presets
    .map((id) => IMAGE_PRESETS.find((p) => p.id === id))
    // `builtin` entries are dropped here as firmly as unknown ids: they are in
    // the base image already, so ticking one must not produce a layer, a new
    // tag, or a rebuild that installs nothing.
    .filter((p): p is ImagePreset => !!p && !p.builtin);
}

/** Is there anything to build on top of the base at all? */
export function hasExtras(x: ImageExtras = getImageExtras()): boolean {
  return knownPresets(x).length > 0 || x.extra.trim().length > 0;
}

/**
 * The Containerfile for the extension layer, or '' when there is nothing to add.
 *
 * Presets first, in the order they were chosen, then the user's own lines: a
 * hand-written line most often depends on a toolchain above it (`cargo install
 * …` after Rust), and never the other way round.
 */
export function extrasContainerfile(x: ImageExtras = getImageExtras()): string {
  if (!hasExtras(x)) return "";
  const parts = [`FROM ${BASE_IMAGE_TAG}`];
  for (const preset of knownPresets(x))
    parts.push(`# preset: ${preset.id}`, ...preset.lines);
  const own = x.extra.trim();
  if (own) parts.push("# added by hand", own);
  parts.push("WORKDIR /work");
  return `${parts.join("\n")}\n`;
}

/**
 * The tag a set of extras builds to.
 *
 * Hashed, not numbered: a version counter would rebuild on every edit and never
 * recognise a return to a previous set, which is the common case — somebody
 * ticks Rust, finds it was not the problem, unticks it. The hash brings the old
 * image straight back, because its tag still exists.
 *
 * Podman tags allow [A-Za-z0-9_][A-Za-z0-9._-]* only, so this is hex after a
 * dash and cannot produce anything else.
 */
export function imageTagFor(x: ImageExtras = getImageExtras()): string {
  const file = extrasContainerfile(x);
  if (!file) return BASE_IMAGE_TAG;
  const hash = createHash("sha256").update(file, "utf8").digest("hex").slice(0, 12);
  return `${BASE_IMAGE_TAG}-${hash}`;
}

/** One line per addition, for a confirmation dialog or a tool result. */
export function describeExtras(x: ImageExtras = getImageExtras()): string[] {
  const out = knownPresets(x).map((p) => `${p.label} (${p.size})`);
  if (x.extra.trim()) out.push("custom Containerfile lines");
  return out;
}
