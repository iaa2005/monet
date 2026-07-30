/**
 * Repo-local ignore patterns for the shadow repo (written to info/exclude).
 * The workspace's own .gitignore is still honoured on top of this; this is a
 * safety net so a workspace WITHOUT a .gitignore doesn't snapshot heavy dirs.
 * `.git/` is always excluded so we never vacuum the user's real repo internals.
 *
 * The build-directory list below was written for a project workspace. Measured on
 * a real data dir, it is not enough: 4.7 GB of 5.6 GB of all checkpoint storage
 * was ONE session whose workspace was `D:/alexivanov/Downloads` — a 602 MB LM
 * Studio installer, a 417 MB zip, a 206 MB installer, a 170 MB PDF — snapshotted
 * because Downloads has no .gitignore and none of these patterns matched.
 *
 * So: archives, installers and media too. Nothing here is something the agent
 * edits, which is what a checkpoint exists to undo. And the app's own data
 * directory, because a workspace at the repository root would otherwise snapshot
 * the checkpoint store into a checkpoint.
 */
export const DEFAULT_EXCLUDES = [
  ".git/",
  // Ours. A checkpoint of the checkpoints is the one that grows without bound.
  ".monet/",
  ".monet-prod/",
  "node_modules/",
  "bower_components/",
  ".pnpm-store/",
  "dist/",
  "build/",
  "out/",
  "target/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".turbo/",
  ".parcel-cache/",
  ".cache/",
  "coverage/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".mypy_cache/",
  ".pytest_cache/",
  ".gradle/",
  ".idea/",
  ".DS_Store",
  "*.log",
  // Installers and disk images.
  "*.exe",
  "*.msi",
  "*.dmg",
  "*.pkg",
  "*.deb",
  "*.rpm",
  "*.AppImage",
  "*.iso",
  "*.vmdk",
  "*.vdi",
  // Archives.
  "*.zip",
  "*.7z",
  "*.rar",
  "*.tar",
  "*.tgz",
  "*.gz",
  "*.xz",
  "*.bz2",
  "*.zst",
  // Media and large binary documents — not things the agent edits, and one of
  // them was 602 MB.
  "*.mp4",
  "*.mov",
  "*.mkv",
  "*.avi",
  "*.webm",
  "*.wav",
  "*.flac",
  "*.psd",
  "*.ai",
  "*.sketch",
  "*.blend",
  "",
].join("\n");
