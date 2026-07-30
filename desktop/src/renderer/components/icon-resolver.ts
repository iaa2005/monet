/**
 * Icon resolver — maps file extensions and folder names to charmed-icons SVGs.
 */

const EXT_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "react",
  js: "javascript",
  jsx: "react",
  mjs: "javascript",
  cjs: "javascript",
  css: "css",
  scss: "scss",
  // No `less` icon in the set; it is a CSS preprocessor, so css reads right.
  less: "css",
  html: "html",
  htm: "html",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  svg: "svg",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  // No `favicon` icon; a .ico IS an image, which is the honest fallback.
  ico: "image",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  scala: "scala",
  cs: "cs",
  php: "php",
  rb: "ruby",
  swift: "swift",
  dart: "dart",
  c: "c",
  h: "c-header",
  cpp: "cpp",
  hpp: "cpp-header",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  bat: "shell",
  cmd: "shell",
  sql: "database",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  csv: "csv",
  env: "config",
  gitignore: "git",
  gitattributes: "git",
  dockerfile: "docker",
  dockerignore: "docker",
  eslint: "eslint",
  prettier: "config",
  lock: "lock",
  "package.json": "node",
  "tsconfig.json": "typescript-config",
  "vite.config": "vite",
  readme: "readme",
  license: "license",
  changelog: "changelog",
  // The set HAS a makefile icon; this pointed at the shell one, which is the
  // same class of mistake as the mappings that pointed at names the set never
  // had. Same symptom too: a file drawn as something it is not.
  makefile: "makefile",
};

/**
 * The rest of the set.
 *
 * Reported: "в дереве не все типы показываются иконки, они рисуются обычным
 * файлом". Measured — the set ships 249 icons and only 102 names were reachable,
 * so 73 FILE icons were sitting on disk that nothing could ever ask for. `.pdf`,
 * `.zip`, `.txt`, `.lua`, `.vue`, `.tex`, fonts, audio, video and a Makefile all
 * drew the generic page.
 *
 * The earlier fix was the opposite mistake — mappings pointing at names the set
 * does not have — and the check only looked in that direction. It looks both ways
 * now.
 *
 * Five icons are still unreachable on purpose, because nothing in a FILENAME can
 * honestly select them: `css3` (an alternative to `css`), `test-teal` and
 * `test-yellow` (colour variants with no signal to pick between them),
 * `roblox-lock`, `event`, and `workflow` — which wants `.github/workflows/`, a PATH, and
 * this resolver is given a name. The probe pins that list, so the next icon added
 * to the set does not quietly join it.
 */
const MORE_EXT: Record<string, string> = {
  // Documents and plain data
  pdf: "pdf",
  txt: "text",
  text: "text",
  rtf: "text",
  log: "text",
  todo: "todo",
  tex: "latex",
  bib: "latex",
  // Archives — one icon for the family
  zip: "zip",
  "7z": "zip",
  rar: "zip",
  tar: "zip",
  gz: "zip",
  tgz: "zip",
  xz: "zip",
  bz2: "zip",
  zst: "zip",
  // Media
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  ogg: "audio",
  m4a: "audio",
  aac: "audio",
  mp4: "video",
  mov: "video",
  mkv: "video",
  avi: "video",
  webm: "video",
  wmv: "video",
  woff: "font",
  woff2: "font",
  ttf: "font",
  otf: "font",
  eot: "font",
  // Binaries and keys
  exe: "binary",
  dll: "binary",
  so: "binary",
  dylib: "binary",
  bin: "binary",
  wasm: "web-assembly",
  pem: "key",
  crt: "key",
  cer: "key",
  pub: "key",
  // Languages the set has and the map did not
  lua: "lua",
  luau: "luau",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  jl: "julia",
  nim: "nim",
  nims: "nim",
  nix: "nix",
  odin: "odin",
  gleam: "gleam",
  zig: "zig",
  zon: "zig",
  pl: "perl",
  pm: "perl",
  f: "fortran",
  f90: "fortran",
  f95: "fortran",
  f77: "fortran-fixed",
  asm: "assembly",
  s: "assembly",
  hcl: "hcl",
  tf: "terraform",
  tfvars: "terraform",
  pcss: "pcss",
  // Named files. These are matched whole, or by suffix — see iconName.
  "go.mod": "go-mod",
  "go.sum": "go-mod",
  "cargo.toml": "rust-config",
  "justfile": "just",
  "jsconfig.json": "javascript-config",
  "package-lock.json": "package-lock",
  "yarn.lock": "yarn-lock",
  ".yarnrc": "yarn",
  ".yarnrc.yml": "yarn",
  ".npmrc": "npm",
  "bun.lockb": "bun-lock",
  "bunfig.toml": "bun",
  "wally.toml": "wally",
  "wally.lock": "wally-lock",
  "code_of_conduct.md": "code-of-conduct",
  codeowners: "codeowners",
  "security.md": "security",
  ".luarc.json": "lua-config",
  // Config files, by the part of the name that identifies them
  "next.config": "next",
  "nuxt.config": "nuxt",
  "astro.config": "astro-config",
  "tailwind.config": "tailwind",
  "drizzle.config": "drizzle-orm",
  ".code-workspace": "vscode",
  sln: "visual-studio",
  ".d.ts": "typescript-def",
  ".d.luau": "luau-def",
  ".stories.ts": "storybook",
  ".stories.tsx": "storybook",
  ".stories.js": "storybook",
  ".nvmrc": "node",
  node: "node",
  // Where the set draws a finer distinction than the map did
  mdx: "markdownx",
  tsx: "react-typescript",
  "package.json": "package-config",
  "npm-shrinkwrap.json": "npm-lock",
  ".luaurc": "luau-config",
  "default.project.json": "roblox-config",
  ".test.ts": "test-blue",
  ".test.tsx": "test-blue",
  ".test.js": "test-blue",
  ".spec.ts": "test-blue",
  ".spec.js": "test-blue",
  // Godot and Roblox, which the set covers
  gd: "godot",
  tscn: "godot",
  tres: "godot",
  import: "godot-assets",
  rbxl: "roblox",
  rbxlx: "roblox",
  rbxm: "roblox-model",
  rbxmx: "roblox-model",
};

const FOLDER_MAP: Record<string, string> = {
  src: "folder_source",
  source: "folder_source",
  app: "folder_source",
  components: "folder_component",
  component: "folder_component",
  pages: "folder_page",
  page: "folder_page",
  routes: "folder_routes",
  lib: "folder_lib",
  utils: "folder_util",
  util: "folder_util",
  hooks: "folder_hooks",
  hook: "folder_hooks",
  types: "folder_types",
  type: "folder_types",
  styles: "folder_styles",
  style: "folder_styles",
  css: "folder_styles",
  public: "folder_web",
  static: "folder_web",
  assets: "folder_assets",
  images: "folder_image",
  image: "folder_image",
  img: "folder_image",
  fonts: "folder_fonts",
  font: "folder_fonts",
  tests: "folder_test",
  __tests__: "folder_test",
  test: "folder_test",
  spec: "folder_test",
  docs: "folder_docs",
  doc: "folder_docs",
  config: "folder_config",
  configs: "folder_config",
  node_modules: "folder_node",
  ".git": "folder_github",
  ".github": "folder_github",
  ".vscode": "folder_vscode",
  dist: "folder_dist",
  build: "folder_dist",
  out: "folder_dist",
  data: "folder_database",
  db: "folder_database",
  audio: "folder_audio",
  video: "folder_video",
  animation: "folder_animation",
  animations: "folder_animation",
  auth: "folder_auth",
  admin: "folder_admin",
  benchmark: "folder_benchmark",
  ci: "folder_script",
  scripts: "folder_script",
  script: "folder_script",
  bin: "folder_bin",
  commands: "folder_commands",
  server: "folder_server",
  client: "folder_client",
  packages: "folder_package",
  package: "folder_package",
  coverage: "folder_coverage",
  temp: "folder_temp",
  tmp: "folder_temp",
  templates: "folder_template",
  template: "folder_template",
  svg: "folder_svg",
  icons: "folder_svg",
  middleware: "folder_middleware",
  models: "folder_model",
  model: "folder_model",
  modules: "folder_module",
  module: "folder_module",
  providers: "folder_provider",
  provider: "folder_provider",
  services: "folder_service",
  service: "folder_service",
  events: "folder_event",
  event: "folder_event",
  functions: "folder_function",
  function: "folder_function",
  connections: "folder_connection",
  connection: "folder_connection",
  context: "folder_context",
  content: "folder_content",
  constants: "folder_constant",
  constant: "folder_constant",
  errors: "folder_error",
  error: "folder_error",
  effects: "folder_effects",
  effect: "folder_effects",
  layouts: "folder_layout",
  layout: "folder_layout",
  input: "folder_input",
  storybook: "folder_storybook",
  stories: "folder_storybook",
  changeset: "folder_changesets",
  changesets: "folder_changesets",
  yarn: "folder_yarn",
  camera: "folder_camera",
};

/**
 * Names that identify a FILE rather than a TYPE, and so may outrank an
 * extension.
 *
 * Deliberately short, and the distinction is the whole point: `readme` belongs
 * here because a README is a README whatever it is written in; `bash` does not,
 * because `bash.svg` is a picture. Getting that backwards made every icon in the
 * icon set render as its own subject.
 */
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
  "tailwind.config": "tailwind",
  "drizzle.config": "drizzle-orm",
};

/** The two tables as one lookup. Kept separate above only so the second one can
 * carry the story of why it exists. */
const ALL_EXT: Record<string, string> = { ...EXT_MAP, ...MORE_EXT };

function iconName(name: string, isDir: boolean, open: boolean): string {
  if (isDir) {
    const key = name.toLowerCase();
    const mapped = FOLDER_MAP[key];
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

  // 5. The extension itself.
  return ALL_EXT[ext] ?? "_file";
}

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
    ...Object.values(ALL_EXT),
  ]);
  for (const folder of Object.values(FOLDER_MAP)) {
    names.add(folder);
    names.add(`${folder}_open`);
  }
  return [...names];
}
