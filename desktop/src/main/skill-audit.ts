/**
 * Our own audit of a skill, run on its files before it is installed.
 *
 * The three services the user named cannot be called: agenttrusthub.ai returns
 * its SPA shell for every /api path, labs.snyk.io has no skill-scan endpoint and
 * no URL prefill (tested with url, skill, target, repo, q and input — all
 * byte-identical), and socket.dev's API needs a key while its web UI 403s bots.
 * So they stay as "open it and paste" links for a second opinion, and the check
 * that runs automatically is this one.
 *
 * The categories come from what those reports actually flag — visible in their
 * own output: REMOTE_CODE_EXECUTION, EXTERNAL_DOWNLOADS, PROMPT_INJECTION,
 * COMMAND_EXECUTION, plus credential access and exfiltration. A `curl | bash` in
 * a SKILL.md is the highest-severity finding in their example and is a regex
 * away; there is no reason to make the user leave the app to learn it.
 *
 * What this is NOT: proof of safety. It reads text and matches patterns, so it
 * finds the careless and the obvious, not the determined. Every message says
 * what was seen and where, so the user judges rather than trusts a badge.
 */

export type Severity = "high" | "medium" | "low";

export interface Finding {
  /** Machine-ish category, matching the vocabulary those reports use. */
  category:
    | "remote_code_execution"
    | "external_download"
    | "credential_access"
    | "exfiltration"
    | "destructive_command"
    | "obfuscation"
    | "prompt_injection";
  severity: Severity;
  /** Which file, and the line, so the claim can be checked. */
  file: string;
  line: number;
  /** What was seen, not what it might mean. */
  detail: string;
  /** The matched text, trimmed — evidence rather than assertion. */
  evidence: string;
}

export interface AuditResult {
  findings: Finding[];
  /** Files actually read. A verdict over two of twenty files is not a verdict. */
  filesScanned: number;
  /** Named so the UI can say what it did not look at. */
  skipped: string[];
  worst: Severity | "none";
}

interface Rule {
  category: Finding["category"];
  severity: Severity;
  detail: string;
  /** Built-in rules only — see the note on `allOf` for why. */
  re?: RegExp;
  /**
   * A catalogue rule: every one of these literals must appear on the same line,
   * matched case-insensitively. No regex, and that is the whole point.
   *
   * Measured, and it changed the design: a pattern from the network CANNOT be
   * made safe with a time budget, because a JavaScript regex cannot be
   * interrupted once it starts. `^(?:[a-z]|[a-z][a-z])+z$` against forty
   * characters of "a" took 15 seconds in a single exec — the budget only gets to
   * look after the exec returns, by which time the app has already frozen.
   *
   * Literal matching is linear and cannot backtrack. It also turns out to be
   * enough for what a new pattern actually needs to say: these words, this line.
   */
  allOf?: string[];
  /** ... and none of these, for carving out the known-innocent case. */
  noneOf?: string[];
  /**
   * Ignore the match when the phrase is quoted.
   *
   * For the phrase rules only, and measured: the two skills flagged for prompt
   * injection across 72 random real ones were both DEFENDING against it — one
   * lists «"ignore previous instructions"» among patterns to reject, the other
   * gives it as an example of an ARIA label not to write. A quoted phrase is
   * being named, not spoken. Command rules keep firing inside backticks, because
   * `curl … | bash` in a fence is how a real installer instruction is written.
   */
  notWhenQuoted?: boolean;
  /** From the repo rather than compiled in. Literal-only, never a regex. */
  fromCatalog?: boolean;
}

/**
 * Ordered by how much they matter, not alphabetically.
 *
 * Every pattern is deliberately narrow. A rule that fires on the word "curl"
 * would flag half the catalogue, and an audit that cries wolf is one people
 * learn to click past — which is worse than not having it.
 */
const RULES: Rule[] = [
  {
    category: "remote_code_execution",
    severity: "high",
    // curl … | bash — the pattern their own example calls a critical risk.
    re: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|k|)sh\b/i,
    detail: "Downloads a script and pipes it straight into a shell",
  },
  {
    category: "remote_code_execution",
    severity: "high",
    re: /\b(?:eval|exec)\s*\(\s*(?:await\s+)?(?:fetch|require\(['"]https?)/i,
    detail: "Evaluates code fetched over the network",
  },
  {
    category: "obfuscation",
    severity: "high",
    re: /base64\s+(?:-d|--decode)[^\n]{0,80}\|\s*(?:ba|z|)sh\b|atob\([^)]{20,}\)\s*\)?\s*(?:;|\))?\s*(?:eval|Function)/i,
    detail: "Decodes then executes — hides what is being run",
  },
  {
    category: "credential_access",
    severity: "high",
    // Measured against real skills: naming a credential path in prose is what
    // documentation does — microsoft/azure-skills tells you to put an SSH
    // *public* key at ~/.ssh/id_rsa.pub, and flagging that was simply wrong. So
    // this needs a verb that consumes the file, and .pub is excluded.
    re: /\b(?:cat|less|more|head|tail|cp|mv|scp|tar|zip|base64|Get-Content|open|read(?:file|_file)?)\b[^\n]{0,80}(?:~|\$HOME|%USERPROFILE%)[/\\]\.(?:aws[/\\]credentials|ssh[/\\]id_[a-z0-9]+(?!\.pub)|config[/\\]gcloud|npmrc|netrc|kube[/\\]config)\b/i,
    detail: "Reads a credential file from the home directory",
  },
  {
    category: "exfiltration",
    severity: "high",
    // A POST whose body is a local file or command output.
    re: /\bcurl\b[^\n]{0,120}(?:-d\s*@|--data-binary\s*@|-F\s+[a-z_]+=@)/i,
    detail: "Uploads a local file to a remote endpoint",
  },
  {
    category: "exfiltration",
    severity: "high",
    // A credential NAME is not a finding — every skill that calls the Claude API
    // mentions ANTHROPIC_API_KEY, and that rule alone accounted for 16 of 26
    // hits across four reputable repos. A credential on a line that also sends
    // somewhere is the thing worth stopping for.
    re: /\b(?:curl|wget|fetch|Invoke-WebRequest|nc)\b[^\n]{0,140}\$?\{?(?:[A-Z_]*(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD)|ANTHROPIC_API_KEY)\}?/,
    detail: "Sends a credential to a network endpoint",
  },
  {
    category: "external_download",
    severity: "medium",
    // "Contacts a URL" is not a risk — measured: every remaining false positive
    // was an ordinary API call (`curl https://api.anthropic.com`, the Azure
    // retail-prices endpoint) or prose containing the word fetch. What matters is
    // pulling down something that then RUNS, so the target has to look like a
    // payload rather than an endpoint.
    re: /\b(?:curl|wget|Invoke-WebRequest)\b[^\n]{0,120}https?:\/\/(?!(?:api\.)?github\.com|raw\.githubusercontent\.com|objects\.githubusercontent\.com)[a-z0-9.-]+[^\s"'`]*?(?:\.(?:sh|bash|zsh|ps1|bat|cmd|exe|msi|dmg|pkg|deb|rpm|jar|py|zip|tgz|whl|tar(?:\.(?:gz|xz|bz2))?)|\/(?:install|installer|setup|get)(?:\.[a-z]+)?)\b/i,
    detail: "Downloads an executable or archive from a host that is not GitHub",
  },
  {
    category: "destructive_command",
    severity: "high",
    // The target has to BE the root or the home directory, not merely start with
    // a slash. Measured: a Japanese safety checklist reading
    // "破壊的操作の確認 (DROP TABLE / rm -rf / force push 等)" matched, because the
    // slash there separates a list. So the target must end the command.
    re: /\brm\s+(?:-[a-zA-Z-]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:-[a-zA-Z-]+\s+)*(?:\/\*?|~\/?\*?|\$HOME\/?\*?|%USERPROFILE%\\?\*?|\*)(?=["'`\s]*(?:$|[;&|#]|--[a-zA-Z]))/,
    detail: "Deletes recursively from the home directory or the filesystem root",
  },
  // `git reset --hard` and force-push had a rule here and it is gone: it fired on
  // azure-skills' blocked-patterns.md — a file whose entire purpose is to LIST
  // the commands you must not run. Destructive git is also already behind Claude
  // Code's own permission prompt at the moment it would happen, so the warning
  // bought nothing and cost two false positives in forty-eight skills.
  {
    category: "prompt_injection",
    severity: "medium",
    re: /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?\b|\bdisregard\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions?)\b/i,
    detail: "Text that tells the model to disregard its instructions",
    notWhenQuoted: true,
  },
  {
    category: "prompt_injection",
    severity: "medium",
    // Narrow on purpose. A rule for "without asking" fired on obra/superpowers'
    // "Honor any existing declared preference without asking" — ordinary prose.
    // This wants the pairing that actually matters: don't tell the user.
    re: /\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention\s+to|notify|show)\s+(?:the\s+)?(?:user|human|owner)\b|\bwithout\s+(?:the\s+)?(?:user|human)['’]?s?\s+(?:knowledge|awareness)\b|\bhide\s+(?:this|it|the\s+\w+)\s+from\s+(?:the\s+)?(?:user|human)\b/i,
    detail: "Text that asks the model to keep something from the user",
    notWhenQuoted: true,
  },
];

// ── Rules from the catalogue ─────────────────────────────────────────────────
//
// Attack patterns change; a new one should not need an app release. So the repo
// can publish more rules and they are merged in behind the built-ins above,
// which always work and never depend on the network.
//
// A regex from the network is code, though, so it is treated as untrusted:
// the category and severity must be ones we know, the pattern must compile, and
// there is a limit on how many and how long. The real defence against a pattern
// that backtracks forever is the time budget in `auditSkill` — the shape check
// below is only a cheap first pass.

const CATEGORIES = new Set<Finding["category"]>([
  "remote_code_execution",
  "external_download",
  "credential_access",
  "exfiltration",
  "destructive_command",
  "obfuscation",
  "prompt_injection",
]);

const MAX_CATALOG_RULES = 60;
/** Per rule: enough to say "curl", "|", "bash"; not enough to write a program. */
const MAX_LITERALS = 8;
const MAX_LITERAL = 120;

export interface ParsedRules {
  rules: Rule[];
  /** Why each rejected entry was rejected — for the log, not a silent drop. */
  rejected: string[];
}

function literals(raw: unknown, what: string, errs: string[]): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_LITERALS) {
    errs.push(`${what} must be an array of at most ${MAX_LITERALS} strings`);
    return null;
  }
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !v || v.length > MAX_LITERAL) {
      errs.push(`${what} takes non-empty strings under ${MAX_LITERAL} characters`);
      return null;
    }
    // Lower-cased once here, since matching lower-cases the line.
    out.push(v.toLowerCase());
  }
  return out;
}

export function parseAuditRules(raw: unknown): ParsedRules {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { rules?: unknown })?.rules)
      ? (raw as { rules: unknown[] }).rules
      : [];
  const rules: Rule[] = [];
  const rejected: string[] = [];
  for (const entry of list) {
    if (rules.length >= MAX_CATALOG_RULES) {
      rejected.push(`over the limit of ${MAX_CATALOG_RULES} rules`);
      break;
    }
    const e = (entry ?? {}) as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : JSON.stringify(entry).slice(0, 40);
    // Said explicitly, because this is the first thing anyone will try: a regex
    // from the network cannot be run safely in this process. See `allOf`.
    if (e.pattern !== undefined || e.regex !== undefined) {
      rejected.push(`${id}: patterns are not accepted — use allOf/noneOf literals`);
      continue;
    }
    if (!CATEGORIES.has(e.category as Finding["category"])) {
      rejected.push(`${id}: unknown category ${String(e.category)}`);
      continue;
    }
    if (e.severity !== "high" && e.severity !== "medium" && e.severity !== "low") {
      rejected.push(`${id}: unknown severity ${String(e.severity)}`);
      continue;
    }
    if (typeof e.detail !== "string" || !e.detail) {
      rejected.push(`${id}: no detail — a finding with no sentence is not usable`);
      continue;
    }
    const errs: string[] = [];
    const allOf = literals(e.allOf, "allOf", errs);
    const noneOf = literals(e.noneOf, "noneOf", errs);
    if (!allOf || !noneOf) {
      rejected.push(`${id}: ${errs.join("; ")}`);
      continue;
    }
    if (!allOf.length) {
      rejected.push(`${id}: allOf is empty — a rule that matches every line`);
      continue;
    }
    rules.push({
      category: e.category as Finding["category"],
      severity: e.severity,
      detail: e.detail.slice(0, 200),
      allOf,
      noneOf,
      notWhenQuoted: e.notWhenQuoted === true,
      fromCatalog: true,
    });
  }
  return { rules, rejected };
}

/** Read as text, or skipped. A .png tells us nothing and a 2 MB blob costs. */
const TEXT_EXT =
  /\.(?:md|markdown|txt|sh|bash|zsh|ps1|bat|cmd|py|js|mjs|cjs|ts|tsx|json|ya?ml|toml|ini|cfg|rb|pl|lua|env)$/i;

export function isAuditableFile(path: string): boolean {
  return TEXT_EXT.test(path) || !/\.[a-z0-9]+$/i.test(path);
}

const ORDER: Record<Severity, number> = { high: 3, medium: 2, low: 1 };


const OPEN = `"'\`«“「`;
const CLOSE = `"'\`»”」`;

/**
 * Where a rule matches on a line, or -1.
 *
 * Returns the index so a quoted phrase can still be recognised, and so the
 * evidence can point at something rather than assert.
 */
function matchAt(rule: Rule, line: string): { at: number; text: string } | null {
  if (rule.re) {
    const m = rule.re.exec(line);
    return m ? { at: m.index, text: m[0] } : null;
  }
  if (!rule.allOf?.length) return null;
  const hay = line.toLowerCase();
  let first = -1;
  for (const lit of rule.allOf) {
    const at = hay.indexOf(lit);
    if (at < 0) return null;
    if (first < 0 || at < first) first = at;
  }
  for (const lit of rule.noneOf ?? []) if (hay.includes(lit)) return null;
  // The whole line is the evidence: with literals there is no single match span,
  // and the line is what the user needs to see to judge it anyway.
  return { at: first, text: line.trim() };
}

/** Is the match wrapped in quotes or backticks — named rather than said? */
function isQuoted(line: string, at: number, len: number): boolean {
  // Allow a little slack for a trailing period inside the quote.
  const before = line.slice(Math.max(0, at - 2), at);
  const after = line.slice(at + len, at + len + 2);
  return (
    [...before].some((c) => OPEN.includes(c)) &&
    [...after].some((c) => CLOSE.includes(c))
  );
}

/**
 * Audit a skill's files.
 *
 * `files` maps a path to its text. Matching is per line so a finding can point
 * at one — a report that says "somewhere in this file" is not checkable, and an
 * unverifiable warning is the kind people dismiss.
 */
export function auditSkill(
  files: Record<string, string>,
  skipped: string[] = [],
  extra: Rule[] = [],
): AuditResult {
  const findings: Finding[] = [];
  const all = extra.length ? [...RULES, ...extra] : RULES;
  for (const [file, content] of Object.entries(files)) {
    const lines = content.split(/\r?\n/);
    for (const rule of all) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const m = matchAt(rule, line);
        if (!m) continue;
        if (rule.notWhenQuoted && isQuoted(line, m.at, m.text.length)) continue;
        findings.push({
          category: rule.category,
          severity: rule.severity,
          file,
          line: i + 1,
          detail: rule.detail,
          evidence: m.text.trim().slice(0, 160),
        });
        // One hit per rule per file: twelve copies of the same warning buries
        // the other eleven rules.
        break;
      }
    }
  }
  findings.sort(
    (a, b) =>
      ORDER[b.severity] - ORDER[a.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
  // One line, one finding — the worst of them.
  //
  // `curl https://x | sh` is genuinely both remote execution and an external
  // download, and reporting it twice is how a useful audit becomes one people
  // click past. Sorted worst-first above, so the first hit on a line wins.
  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    const at = `${f.file}:${f.line}`;
    if (seen.has(at)) return false;
    seen.add(at);
    return true;
  });
  return {
    findings: deduped,
    filesScanned: Object.keys(files).length,
    skipped,
    worst: deduped.length ? deduped[0]!.severity : "none",
  };
}
