/**
 * Read a skill before installing it.
 *
 * A skill is instructions the model will follow, and in a registry of 23 472
 * entries most come from strangers. Sending the user to github.com was better
 * than nothing, but the decision is made here, so the text should be here — the
 * link out stays, as the thing you reach for when you want the real page.
 *
 * The scanners below take a URL pasted into a box. None of them prefills from a
 * query parameter: tested against labs.snyk.io with url, skill, target, repo, q
 * and input — every one returned byte-identical HTML with no trace of the
 * target. So the button copies the skill's URL and opens the tool, and says
 * that is what it did. Pretending to prefill would send people to an empty form
 * wondering what went wrong.
 */

import { useEffect, useState } from "react";
import {
  Boxes,
  ChevronDown,
  ClipboardCheck,
  ExternalLink,
  FileText,
  Loader2,
  Plus,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownViewer } from "@/components/chat/MarkdownViewer";
import type { AuditFinding, SkillAudit, StoreSkill } from "@/types/electron";
import { api } from "./shared";
import { OwnerAvatar, ownerOf } from "./OwnerAvatar";
import { AgentIcon } from "./AgentIcon";

/** The scanners, in the order the user named them. Each takes a pasted URL. */
const SCANNERS = [
  {
    name: "Agent Trust Hub",
    url: "https://agenttrusthub.ai/skill-scanner",
    note: "Skill scanner",
  },
  {
    name: "Snyk Labs",
    url: "https://labs.snyk.io/experiments/skill-scan/",
    note: "Skill Inspector — its own box asks for a github.com URL",
  },
  {
    name: "Socket",
    url: "https://socket.dev",
    note: "Supply-chain analysis",
  },
];

/** Plain-English headings for what the check found. */
const CATEGORY: Record<AuditFinding["category"], string> = {
  remote_code_execution: "Runs code from the internet",
  external_download: "Downloads from outside GitHub",
  credential_access: "Touches credentials",
  exfiltration: "Sends local data out",
  destructive_command: "Deletes or rewrites",
  obfuscation: "Hides what it runs",
  prompt_injection: "Instructions aimed at the model",
};

const TONE = {
  high: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  medium: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  low: "border-border bg-black/[0.03] text-muted-foreground dark:bg-white/[0.05]",
} as const;

/** How many findings to show before folding the rest away. */
const SHOWN = 6;

/**
 * Which agent a folder belongs to, and what to call it.
 *
 * Mirrors AGENT_FOLDERS in src/main/agent-folders.ts. Kept as a small map rather
 * than an import because the renderer does not reach into main — and the labels
 * are the only part the UI needs.
 */
const AGENT_BY_DIR: Record<string, { id: string; label: string }> = {
  ".monet": { id: "monet", label: "Code Monet" },
  ".claude": { id: "claude-code", label: "Claude Code" },
  ".agents": { id: "agents", label: "Any agent" },
  ".cursor": { id: "cursor", label: "Cursor" },
  ".codex": { id: "codex", label: "Codex" },
  ".github": { id: "github-copilot", label: "GitHub Copilot" },
  ".gemini": { id: "gemini", label: "Gemini" },
  ".antigravity": { id: "antigravity", label: "Antigravity" },
  ".windsurf": { id: "windsurf", label: "Windsurf" },
  ".cline": { id: "cline", label: "Cline" },
  ".amp": { id: "amp", label: "AMP" },
  ".clawdbot": { id: "clawdbot", label: "ClawdBot" },
  ".droid": { id: "droid", label: "Droid" },
  ".goose": { id: "goose", label: "Goose" },
  ".grok": { id: "grok", label: "Grok" },
  ".kilo": { id: "kilo", label: "Kilo" },
  ".kiro": { id: "kiro-cli", label: "Kiro CLI" },
  ".opencode": { id: "opencode", label: "OpenCode" },
  ".pi": { id: "pi", label: "Pi" },
  ".qoder": { id: "qoder", label: "Qoder" },
  ".roo": { id: "roo", label: "Roo" },
  ".rovodev": { id: "rovodev", label: "Rovo Dev" },
  ".trae": { id: "trae", label: "Trae" },
  ".trae-cn": { id: "trae-cn", label: "Trae CN" },
  ".vibe": { id: "vibe", label: "Vibe" },
  ".vscode": { id: "vscode", label: "VS Code" },
  ".zed": { id: "zed", label: "Zed" },
};

/** The agent a variant folder is for, or a plain label for a neutral one. */
function variantAgent(dir: string): { id: string; label: string } {
  const known = AGENT_BY_DIR[dir.split("/")[0] ?? ""];
  if (known) return known;
  // Not an agent folder: `skills/x`, `plugin/skills/x`. Name it by its root so
  // two neutral variants are still told apart.
  const root = dir.split("/")[0] ?? dir;
  return { id: `dir:${root}`, label: root };
}

interface Preview {
  repo?: string;
  dir?: string;
  variants?: string[];
  files?: string[];
  content?: string;
  texts?: Record<string, string>;
  url?: string;
  audit?: SkillAudit;
  error?: string;
  candidates?: string[];
}

export function SkillPreview({
  skill,
  installing,
  onInstall,
  onClose,
}: {
  skill: StoreSkill;
  installing: boolean;
  /** Carries the picked variant folder, when the user chose one. */
  onInstall: (dir?: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [data, setData] = useState<Preview | null>(null);
  const [file, setFile] = useState("SKILL.md");
  const [copied, setCopied] = useState("");
  const [showAll, setShowAll] = useState(false);
  /** A high finding costs one extra click, so Install is never a reflex. */
  const [ack, setAck] = useState(false);
  /**
   * The variant the user chose, when a repo ships one copy per agent.
   *
   * null means "whatever the resolver picked" — which is our own folder if the
   * repo has one, then Claude's, then a neutral one. Choosing re-reads the
   * preview, because the copies are NOT identical: measured on
   * pbakaus/impeccable, fifteen folders held fourteen different files.
   */
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // A different skill — or a different agent's copy of it — starts over:
    // showing the previous verdict, or carrying its acknowledgement across,
    // would be the worst kind of bug here.
    setData(null);
    setFile("SKILL.md");
    setShowAll(false);
    setAck(false);
    void api()
      ?.skillStore.preview({
        source: skill.source,
        path: skill.path,
        kind: skill.kind,
        repository: skill.repository,
        hint: skill.hint,
        name: skill.name,
        ...(chosen ? { dir: chosen } : {}),
      })
      .then((r) => {
        if (!alive) return;
        setData(
          r?.ok
            ? { ...r }
            : { error: r?.error ?? "Could not read this skill.", candidates: r?.candidates },
        );
      })
      .catch(() => alive && setData({ error: "Could not read this skill." }));
    return () => {
      alive = false;
    };
  }, [skill.uid, chosen]);

  /** The address a scanner wants pasted, and the one the link opens. */
  const target = data?.url ?? skill.url ?? "";
  /** null while reading — and if the read failed there is nothing to audit. */
  const report = data?.audit ?? null;
  const unread = data?.error !== undefined;
  /** Only a high finding earns a second click — asking twice for everything is
   * how a confirmation stops being read. First click arms, second installs. */
  const risky = report?.worst === "high";
  const gated = risky && !ack;
  const armed = risky && ack;
  /** Worst severity per file, for the dots in the file list. */
  const flagged: Record<string, AuditFinding["severity"]> = {};
  for (const f of report?.findings ?? [])
    if (!flagged[f.file]) flagged[f.file] = f.severity; // findings arrive worst-first

  const openScanner = async (scanner: (typeof SCANNERS)[number]): Promise<void> => {
    // Copy first: if opening the browser steals focus, the clipboard is already
    // set and the paste works.
    if (target) {
      try {
        await navigator.clipboard.writeText(target);
        setCopied(scanner.name);
        setTimeout(() => setCopied(""), 4000);
      } catch {
        /* the URL is on screen below regardless */
      }
    }
    void api()?.shell.openExternal(scanner.url);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="flex h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2.5 border-b border-border px-5 py-3.5">
          <OwnerAvatar owner={ownerOf(skill.repository ?? skill.source)} size={24} />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold">/{skill.name}</h3>
            <p className="truncate text-xs text-muted-foreground">
              {data?.repo && data?.dir
                ? `${data.repo}/${data.dir}`
                : (skill.repository ?? skill.source)}
            </p>
          </div>
          {target && (
            <button
              type="button"
              onClick={() => void api()?.shell.openExternal(target)}
              title={`Open ${target.replace(/^https:\/\//, "")}`}
              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="size-3.5" /> Source
            </button>
          )}
          {skill.installed ? (
            <span className="rounded-lg px-2.5 py-1.5 text-[12px] text-green-text">
              Installed
            </span>
          ) : (
            <button
              type="button"
              disabled={installing}
              onClick={() => (gated ? setAck(true) : onInstall(chosen ?? undefined))}
              title={risky ? "The audit found something rated high — see below" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium disabled:opacity-60",
                armed
                  ? "bg-red-600 text-white hover:bg-red-500"
                  : "bg-foreground text-background",
              )}
            >
              {installing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : armed ? (
                <ShieldAlert className="size-3.5" />
              ) : (
                <Plus className="size-3.5" />
              )}
              {armed ? "Install anyway" : "Install"}
            </button>
          )}
        </div>

        {/* One skill per agent, so which one are we installing?
            Above the audit deliberately: the copies differ, so choosing changes
            what the audit is about. */}
        {(data?.variants?.length ?? 0) > 1 && (
          <div className="border-b border-border px-5 py-3">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <Boxes className="size-3.5" />
              This repository ships {data!.variants!.length} copies, one per agent
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {data!.variants!.map((v) => {
                const a = variantAgent(v);
                const active = v === (data!.dir ?? "");
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setChosen(v)}
                    title={v}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition-colors",
                      active
                        ? "border-foreground/30 bg-black/[0.06] font-medium text-foreground dark:bg-white/[0.08]"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <AgentIcon id={a.id} label={a.label} size={13} />
                    {a.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {/* Said plainly, because it is the reason this row exists at all:
                  the copies are not duplicates. */}
              These copies are not identical — each writes its own folder into the
              instructions, so another agent&apos;s copy points at a directory this
              app does not have.
            </p>
          </div>
        )}

        {/* The audit, before install rather than after. */}
        <div className="border-b border-border px-5 py-3">
          <div className="mb-2 flex items-center gap-2">
            {report === null ? (
              unread ? (
                <ShieldQuestion className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              )
            ) : report.worst === "none" ? (
              <ShieldCheck className="size-3.5 shrink-0 text-green-text" />
            ) : (
              <ShieldAlert
                className={cn(
                  "size-3.5 shrink-0",
                  report.worst === "high" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400",
                )}
              />
            )}
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Security audit
            </span>
            {report && (
              // The scope of the claim, next to the claim itself: a clean verdict
              // over 2 of 20 files is not the same as one over all of them.
              <span className="ml-auto truncate text-[11px] text-muted-foreground">
                {report.filesScanned} file{report.filesScanned === 1 ? "" : "s"} read
                {report.skipped.length > 0 && `, ${report.skipped.length} not text`}
              </span>
            )}
          </div>

          {report === null ? (
            <p className="text-[12px] text-muted-foreground">
              {unread
                ? // Nothing was read, so saying "nothing found" would be a lie.
                  "The files could not be read, so nothing was checked."
                : "Checking the files…"}
            </p>
          ) : report.findings.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              Nothing flagged in what we read. This is a pattern check, not proof —
              read the instructions below, and get a second opinion if it matters.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {(showAll ? report.findings : report.findings.slice(0, SHOWN)).map((f) => (
                <li
                  key={`${f.file}:${f.line}:${f.category}`}
                  className={cn("rounded-lg border px-2.5 py-1.5", TONE[f.severity])}
                >
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[12px] font-medium">{CATEGORY[f.category]}</span>
                    {/* The claim is checkable only if the file is one click away. */}
                    <button
                      type="button"
                      onClick={() => setFile(f.file)}
                      title={`Show ${f.file}`}
                      className="ml-auto shrink-0 font-mono text-[10px] underline decoration-dotted opacity-70 transition-opacity hover:opacity-100"
                    >
                      {f.file}:{f.line}
                    </button>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug opacity-90">{f.detail}</p>
                  {/* The matched text, so the user judges the finding rather than
                      trusting it. */}
                  <code className="mt-1 block overflow-x-auto whitespace-pre rounded bg-black/[0.06] px-1.5 py-1 font-mono text-[10.5px] dark:bg-black/25">
                    {f.evidence}
                  </code>
                </li>
              ))}
              {report.findings.length > SHOWN && !showAll && (
                <li>
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronDown className="size-3" />
                    {report.findings.length - SHOWN} more
                  </button>
                </li>
              )}
            </ul>
          )}

          {/* A second opinion, from the three the user named. None of them takes a
              target in its URL, so this copies and says so. */}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="mr-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
              <ShieldQuestion className="size-3" />
              Second opinion:
            </span>
            {SCANNERS.map((sc) => (
              <button
                key={sc.name}
                type="button"
                disabled={!target}
                title={`${sc.note} — copies this skill's URL and opens ${sc.url.replace(/^https:\/\//, "")}`}
                onClick={() => void openScanner(sc)}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] transition-colors hover:bg-black/[0.05] disabled:opacity-50 dark:hover:bg-white/[0.06]"
              >
                {copied === sc.name ? (
                  <ClipboardCheck className="size-3 text-green-text" />
                ) : (
                  <ExternalLink className="size-3 text-muted-foreground" />
                )}
                {sc.name}
              </button>
            ))}
          </div>
          {copied && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              URL copied — paste it into {copied}, none of them accepts it in the address.
            </p>
          )}
        </div>

        <div className="flex min-h-0 flex-1">
          {(data?.files?.length ?? 0) > 1 && (
            <div className="w-56 shrink-0 overflow-y-auto border-r border-border py-2">
              {data!.files!.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFile(f)}
                  className={cn(
                    "flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[12px]",
                    f === file
                      ? "bg-black/[0.05] text-foreground dark:bg-white/[0.06]"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <FileText className="size-3 shrink-0" />
                  <span className="truncate">{f}</span>
                  {/* A dot on the files the audit had something to say about. */}
                  {flagged[f] && (
                    <span
                      title={`Audit flagged ${f}`}
                      className={cn(
                        "ml-auto size-1.5 shrink-0 rounded-full",
                        flagged[f] === "high" ? "bg-red-500" : "bg-amber-500",
                      )}
                    />
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {data === null ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Reading the skill…
              </div>
            ) : data.error ? (
              <div className="text-sm text-destructive">
                {data.error}
                {data.candidates?.length ? (
                  <>
                    {/* The install would fail here too, for the same reason. */}
                    <p className="mt-2 text-muted-foreground">
                      Candidate folders in that repository:
                    </p>
                    <ul className="mt-1 list-inside list-disc text-muted-foreground">
                      {data.candidates.slice(0, 8).map((c) => (
                        <li key={c} className="font-mono text-[12px]">
                          {c}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            ) : file === "SKILL.md" ? (
              <MarkdownViewer content={data.content ?? ""} />
            ) : data.texts?.[file] !== undefined ? (
              // The audit already downloaded this file, so the script the warning
              // points at is readable here instead of on github.com.
              /\.(?:md|markdown)$/i.test(file) ? (
                <MarkdownViewer content={data.texts[file]!} />
              ) : (
                <pre className="overflow-x-auto whitespace-pre font-mono text-[12px] leading-relaxed text-foreground">
                  {data.texts[file]}
                </pre>
              )
            ) : (
              // Binaries and anything past the read cap: named, not fetched.
              <p className="text-sm text-muted-foreground">
                {file} ships with this skill but was not downloaded — open the
                source to read it.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
