// Content for the verify bundled skill.
// Patched: replaced build-time .md imports with runtime fs.readFileSync
// (original code used `import x from './file.md'` which only works with bun build)

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readMd(relPath: string): string {
  return readFileSync(join(__dirname, relPath), "utf-8");
}

const skillMd = readMd("verify/SKILL.md");
const cliMd = readMd("verify/examples/cli.md");
const serverMd = readMd("verify/examples/server.md");

export const SKILL_MD: string = skillMd;

export const SKILL_FILES: Record<string, string> = {
  "examples/cli.md": cliMd,
  "examples/server.md": serverMd,
};
