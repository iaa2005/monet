/**
 * PATH for a GUI launch.
 *
 * A macOS app started from Finder or the Dock inherits launchd's environment:
 * PATH is `/usr/bin:/bin:/usr/sbin:/sbin` and SHELL is unset. Everything the
 * user installed — Homebrew, nvm, pyenv, podman, language servers — is
 * invisible to a plain spawn() from main, even though it works fine in their
 * terminal. (The agent's Bash tool survives because it starts a login shell;
 * direct spawns of `chrome`, `podman`, LSP servers and `which` do not.)
 *
 * So, once at startup: ask the user's login shell for its PATH and graft it
 * onto process.env. Interactive-login (`-ilc`) because that is where zsh reads
 * .zprofile AND .zshrc — nvm and friends init in the rc file. A shell that
 * hangs on input (a misconfigured rc waiting on a prompt) is cut off by the
 * timeout, and the app keeps the PATH it had — degraded, not dead.
 */

import { execFileSync } from "child_process";
import { userInfo } from "os";

// Between the shell printing PATH and any rc noise around it, take the line
// that actually looks like one. The marker guards against rc files that echo.
const MARKER = "__MONET_PATH__";

export function fixGuiPath(): void {
  if (process.platform === "win32") return;
  // A terminal launch already has the real PATH; a second login shell would
  // only slow startup. Homebrew's dirs are the tell on macOS.
  const current = process.env.PATH ?? "";
  const looksLikeGui =
    !current.includes("/opt/homebrew/bin") &&
    !current.includes("/usr/local/bin");
  if (!looksLikeGui) return;

  const shell =
    process.env.SHELL || userInfo().shell || "/bin/zsh";

  try {
    const out = execFileSync(shell, ["-ilc", `printf '${MARKER}%s${MARKER}' "$PATH"`], {
      encoding: "utf8",
      timeout: 5000,
      // No stdin: an rc that reads input gets EOF instead of hanging us.
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.split(MARKER);
    const path = m.length >= 2 ? m[1] : "";
    if (path && path.includes("/")) {
      // Merge rather than replace: keep anything already present (e.g. the
      // podman dir prepended by podman-binary.ts before this ran).
      const have = new Set(current.split(":"));
      const merged = [
        ...current.split(":").filter(Boolean),
        ...path.split(":").filter((p) => p && !have.has(p)),
      ];
      process.env.PATH = merged.join(":");
      console.log(`[shell-path] PATH from ${shell}: ${process.env.PATH}`);
    }
  } catch (err) {
    console.warn(
      `[shell-path] could not read PATH from ${shell}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
