/**
 * See the paths inside a shell command.
 *
 * The sensitive-file stage judged calls by their path ARGUMENTS, so
 * `Read(.env)` asked the user and `cat .env` did not — the same bytes, reached
 * through the one tool whose input is a string the policy never looked inside.
 * little-coder hit the identical shape with its write-guard (`cat > main.py
 * << 'EOF'` rode straight past a name-matched refusal) and settled on the
 * same cure ported here: a pure, quote-aware walk over the command string,
 * judging every token rather than only the first word.
 *
 * This is an accident guard, not an adversary guard. A command that hides a
 * path behind base64 or a variable will get through — and that is fine,
 * because the stage it feeds only ASKS; the cost of a miss is one skipped
 * question, and the sandbox and the user's eyes remain the layers below.
 * What must not get through is the ordinary case: the model casually
 * `cat`-ing credentials mid-task because nothing prompted it to pause.
 *
 * Pure string work, no shell, no fs — decidable in a probe.
 */

import { isSensitivePath } from "./secret-filter.js";

/**
 * Split a command into word-shaped tokens, respecting quotes.
 *
 * One tokenizer serves both shells the app runs (bash and PowerShell):
 *  - '...' and "..." group; the quotes themselves drop out, so `cat ".env"`
 *    yields the token `.env`.
 *  - `\` and PowerShell's backtick escape ONLY when the next character is a
 *    quote, whitespace or another escape. A bare backslash is a Windows path
 *    separator — treating it as an escape would dissolve `C:\Users\x\.env`.
 *  - Chain and redirect operators (| & ; < > and parentheses) end a token,
 *    so every segment of `ls && cat .env` is judged, not just the first.
 */
export function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  const flush = (): void => {
    if (current) tokens.push(current);
    current = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1] ?? "";
    if (quote) {
      if (ch === quote) quote = null;
      else if ((ch === "\\" || ch === "`") && next === quote) {
        current += next;
        i++;
      } else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if ((ch === "\\" || ch === "`") && /["'`\\\s]/.test(next)) {
      current += next;
      i++;
      continue;
    }
    if (/\s/.test(ch) || "|&;<>()".includes(ch)) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return tokens;
}

/**
 * The first token of `command` that names a credential-shaped file, or null.
 *
 * Tokens containing whitespace are skipped: they can only come from quoted
 * strings, and a quoted string with spaces is prose — a commit message
 * mentioning ".env" must not trip a file guard. The rare path-with-spaces
 * ending in a secret name is a miss this trade accepts.
 */
export function sensitivePathInCommand(command: string): string | null {
  for (const token of shellTokens(command)) {
    if (/\s/.test(token)) continue;
    if (isSensitivePath(token)) return token;
  }
  return null;
}

/**
 * Windows reserved device names. A file whose basename is one of these —
 * with any extension, in any case — resolves to a DOS device on Windows
 * rather than a file, and a tool that does create one (over \\?\ paths, or
 * on a filesystem mounted elsewhere) leaves a landmine that breaks the repo
 * the moment it is cloned on Windows. The model writing `nul` is essentially
 * always a mistake — it wanted /dev/null. (Ported from little-coder's
 * write-guard, which blocks these on every platform for the same reason.)
 */
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** True when the path's final segment is a reserved Windows device name. */
export function isReservedDevicePath(filePath: string): boolean {
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  return RESERVED_DEVICE.test(base);
}
