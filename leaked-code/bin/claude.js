#!/usr/bin/env bun
/**
 * Claude Code CLI entry point.
 * Usage: claude [options] [prompt]
 *   claude --help
 *   claude --version
 *   claude -p "explain this code"
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Preload MACRO build-time constants
const preloadPath = resolve(root, 'macro_preload.ts');
const imports = await import(preloadPath);

// Now load the actual CLI entrypoint
await import(resolve(root, 'entrypoints', 'cli.tsx'));
