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
  makefile: "shell",
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

  const dot = name.lastIndexOf(".");
  if (dot === -1) {
    const mapped = EXT_MAP[name.toLowerCase()];
    return mapped ?? "_file";
  }

  const ext = name.slice(dot + 1).toLowerCase();
  const mapped = EXT_MAP[ext];
  if (mapped) return mapped;

  const lower = name.toLowerCase();
  for (const [pattern, icon] of Object.entries(EXT_MAP)) {
    if (pattern.includes(".") && lower === pattern) return icon;
    if (pattern.includes(".") && lower.endsWith(pattern)) return icon;
  }

  return "_file";
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
    ...Object.values(EXT_MAP),
  ]);
  for (const folder of Object.values(FOLDER_MAP)) {
    names.add(folder);
    names.add(`${folder}_open`);
  }
  return [...names];
}
