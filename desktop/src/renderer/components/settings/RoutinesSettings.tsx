/**
 * Routines — templated agent tasks kicked off on a schedule (cron), manually,
 * or (later) by webhook/connector event. Draft one from natural language, start
 * from a template, or hand-edit. Each run produces a new chat.
 */
import { useEffect, useState } from "react";
import {
  Zap,
  Plus,
  Clock,
  Sun,
  Mail,
  LineChart,
  ListChecks,
  GitPullRequest,
  PackageSearch,
  FileText,
  FlaskConical,
  Play,
  Trash2,
  Loader2,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Switch } from "@/components/ui/switch";
import { MicButton } from "@/components/chat/MicButton";
import { cn } from "@/lib/utils";
import type { ElectronAPI, Routine } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

type RoutineRow = Routine & { humanSchedule?: string };

interface Draft {
  id?: string;
  name: string;
  prompt: string;
  space: "home" | "code";
  triggerKind: "schedule" | "webhook" | "manual" | "event";
  cron: string;
  webhookId?: string;
  eventConnector: string;
  eventType: string;
  eventInterval: number;
  eventFilter: string;
  connectors: string[];
  outputKind: "chat" | "notification" | "connector";
  outputConnector: string;
  condition: string;
  enabled: boolean;
}

const SUGGESTIONS = [
  "Summarize my open PRs every weekday morning",
  "Triage new issues and flag duplicates each morning",
  "Draft release notes whenever a PR merges",
];

interface Template {
  icon: LucideIcon;
  name: string;
  desc: string;
  cron: string;
  space: "home" | "code";
  worksWith?: string;
  prompt: string;
}

const TEMPLATES: Template[] = [
  { icon: Sun, name: "Briefing", desc: "Summary of your calendar, emails, and messages.", cron: "30 9 * * 1-5", space: "code", worksWith: "Google Calendar · Gmail · Slack", prompt: "Give me a briefing: summarize today's calendar, important emails, and unread messages. Keep it short and prioritized." },
  { icon: Mail, name: "Email triage", desc: "Categorize and prioritize your inbox, with draft responses for urgent items.", cron: "0 18 * * 1-5", space: "code", worksWith: "Gmail", prompt: "Triage my inbox: categorize and prioritize new emails, and draft responses for anything urgent." },
  { icon: LineChart, name: "System health check", desc: "Monitor infrastructure and services for errors, outages, and performance issues.", cron: "0 15 * * *", space: "code", worksWith: "PagerDuty · Datadog · Sentry", prompt: "Check system health: look for errors, outages, and performance regressions across our services and summarize anything that needs attention." },
  { icon: ListChecks, name: "Issue triage", desc: "Review and categorize incoming issues, bugs, and feature requests.", cron: "30 18 * * 1-5", space: "code", worksWith: "Linear", prompt: "Triage new issues: categorize incoming bugs and feature requests, flag likely duplicates, and suggest labels/priority." },
  { icon: GitPullRequest, name: "PR review digest", desc: "Overview of open PRs, review status, and what needs attention.", cron: "0 21 * * 1-5", space: "code", prompt: "Summarize open pull requests: review status, what's blocked, and what needs my attention." },
  { icon: PackageSearch, name: "Dependency update check", desc: "Scan for outdated packages, security patches, and breaking changes.", cron: "30 21 * * 1", space: "code", prompt: "Scan dependencies for outdated packages, security patches, and breaking changes; summarize what to update and the risk." },
  { icon: FileText, name: "Release notes drafter", desc: "Draft user-facing release notes from recent merges.", cron: "0 17 * * 5", space: "code", prompt: "Draft user-facing release notes from the changes merged to the main branch since the last release." },
  { icon: FlaskConical, name: "Flaky test tracker", desc: "Find tests that pass and fail intermittently across recent CI runs.", cron: "0 19 * * 1", space: "code", prompt: "Find flaky tests: identify tests that pass and fail intermittently across recent CI runs and summarize the worst offenders." },
];

function emptyDraft(): Draft {
  return { name: "", prompt: "", space: "code", triggerKind: "schedule", cron: "0 9 * * 1-5", eventConnector: "", eventType: "", eventInterval: 15, eventFilter: "", connectors: [], outputKind: "chat", outputConnector: "", condition: "", enabled: true };
}

export function RoutinesSettings({
  onOpenChat,
}: {
  onOpenChat?: (sessionId: string) => void;
} = {}): JSX.Element {
  const [routines, setRoutines] = useState<RoutineRow[]>([]);
  const [desc, setDesc] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [editor, setEditor] = useState<Draft | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const load = (): void => {
    void api()
      ?.routines.list()
      .then((r) => setRoutines((r as RoutineRow[]) ?? []))
      .catch(() => {});
  };
  useEffect(() => {
    load();
    return api()?.routines.onRan(() => load());
  }, []);

  const draftFromText = async (text: string): Promise<void> => {
    if (!text.trim()) return;
    setDrafting(true);
    try {
      const r = await api()?.routines.draft(text.trim(), "code");
      if (r?.ok && r.draft)
        setEditor({ ...emptyDraft(), name: r.draft.name, prompt: r.draft.prompt, cron: r.draft.cron, space: r.draft.space });
      else setEditor({ ...emptyDraft(), prompt: text.trim() });
    } finally {
      setDrafting(false);
    }
  };

  const fromTemplate = (t: Template): void =>
    setEditor({ ...emptyDraft(), name: t.name, prompt: t.prompt, cron: t.cron, space: t.space });

  const runNow = async (id: string): Promise<void> => {
    setRunningId(id);
    try {
      const run = (await api()?.routines.runNow(id)) as
        | { sessionId?: string; status?: string }
        | null;
      load();
      if (run?.sessionId && onOpenChat) onOpenChat(run.sessionId);
    } finally {
      setRunningId(null);
    }
  };

  const openLastResult = async (id: string): Promise<void> => {
    const runs = (await api()?.routines.listRuns(id)) as
      | { sessionId?: string }[]
      | undefined;
    const last = runs?.find((r) => r.sessionId);
    if (last?.sessionId && onOpenChat) onOpenChat(last.sessionId);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Zap className="size-4" />
            Routines
          </h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Templated routines that run on a schedule (webhook &amp; connector
            events coming). Each run opens a new chat with the result.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditor(emptyDraft())}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
        >
          <Plus className="size-4" />
          New routine
        </button>
      </div>

      {/* What do you want automated? */}
      <div className="glass-panel rounded-xl border border-border p-3 bg-card">
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="What do you want automated?"
          rows={2}
          className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setDesc(s)}
              className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.05]"
            >
              {s}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1.5">
            <MicButton
              onText={(t) =>
                setDesc((prev) => (prev ? prev.trimEnd() + " " : "") + t)
              }
            />
            <button
              type="button"
              disabled={!desc.trim() || drafting}
              onClick={() => void draftFromText(desc)}
              className="flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {drafting && <Loader2 className="size-3 animate-spin" />}
              Draft routine
            </button>
          </div>
        </div>
      </div>

      {/* Existing routines / empty */}
      {routines.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1 py-10 text-muted-foreground">
          <Clock className="size-6" />
          <span className="text-sm">No routines yet.</span>
        </div>
      ) : (
        <div className="space-y-2">
          {routines.map((r) => (
            <div
              key={r.id}
              className="glass-panel flex items-center gap-3 rounded-xl border border-border p-3 bg-card"
            >
              <Switch
                checked={r.enabled}
                onChange={(v) => {
                  void api()?.routines.setEnabled(r.id, v);
                  setRoutines((prev) =>
                    prev.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)),
                  );
                }}
              />
              <button
                type="button"
                onClick={() =>
                  setEditor({
                    id: r.id,
                    name: r.name,
                    prompt: r.prompt,
                    space: r.space,
                    triggerKind:
                      r.trigger.kind === "webhook"
                        ? "webhook"
                        : r.trigger.kind === "manual"
                          ? "manual"
                          : r.trigger.kind === "event"
                            ? "event"
                            : "schedule",
                    cron: r.trigger.cron ?? "0 9 * * 1-5",
                    webhookId: r.trigger.webhookId,
                    eventConnector: r.trigger.event?.connector ?? "",
                    eventType: r.trigger.event?.type ?? "",
                    eventInterval: r.trigger.event?.intervalMinutes ?? 15,
                    eventFilter: r.trigger.event?.filter ?? "",
                    connectors: r.connectors ?? [],
                    outputKind: r.output?.kind ?? "chat",
                    outputConnector: r.output?.connector ?? "",
                    condition: r.condition?.prompt ?? "",
                    enabled: r.enabled,
                  })
                }
                className="min-w-0 flex-1 text-left"
              >
                <div className="truncate text-sm font-medium">{r.name}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="size-3" />
                  {r.trigger.kind === "schedule"
                    ? (r.humanSchedule ?? r.trigger.cron ?? "schedule")
                    : r.trigger.kind === "event"
                      ? `every ${r.trigger.event?.intervalMinutes ?? 15}m · ${r.trigger.event?.type || r.trigger.event?.connector || "event"}`
                      : r.trigger.kind === "webhook"
                        ? "webhook"
                        : "manual"}
                  {r.lastStatus && (
                    <span
                      className={cn(
                        "ml-1 rounded px-1 py-0.5 text-[10px]",
                        r.lastStatus === "ok" && "bg-green-bg text-green-text",
                        r.lastStatus === "error" && "bg-red-bg text-red-text",
                        r.lastStatus === "skipped" && "bg-muted text-muted-foreground",
                      )}
                    >
                      {r.lastStatus}
                    </span>
                  )}
                </div>
              </button>
              {r.lastStatus === "ok" && onOpenChat && (
                <button
                  type="button"
                  onClick={() => void openLastResult(r.id)}
                  title="Open last result chat"
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
                >
                  <ExternalLink className="size-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => void runNow(r.id)}
                disabled={runningId === r.id}
                title="Run now"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
              >
                {runningId === r.id ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  void api()?.routines.delete(r.id);
                  setRoutines((prev) => prev.filter((x) => x.id !== r.id));
                }}
                title="Delete"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Templates */}
      <div>
        <div className="mb-2 text-sm text-muted-foreground">
          Or start from a template
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => fromTemplate(t)}
              className="glass-panel glass-hover rounded-xl border border-border p-3 text-left transition-colors min-h-30 flex flex-col justify-between bg-card"
            >
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <t.icon className="size-4" />
                  {t.name}
                </div>
                <p className="mt-1 text-[13px] text-muted-foreground">{t.desc}</p>
              </div>
              {t.worksWith && (
                <p className="mt-1 text-[11px] text-muted-foreground/70">
                  Works with {t.worksWith}
                </p>
              )}
            </button>
          ))}
        </div>
      </div>

      {editor && (
        <RoutineEditor
          draft={editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setDesc("");
            load();
          }}
        />
      )}
    </div>
  );
}

function RoutineEditor({
  draft,
  onClose,
  onSaved,
}: {
  draft: Draft;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [d, setD] = useState<Draft>(draft);
  const [preview, setPreview] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [trig, setTrig] = useState<{ baseUrl: string; apiKey: string } | null>(null);
  // Connector accounts AND raw MCP servers — mcp.list() alone went blank once
  // connectors moved out of mcp-servers.json into the encrypted store.
  const [servers, setServers] = useState<
    { id: string; label: string; kind: "connector" | "mcp" }[]
  >([]);
  const set = (patch: Partial<Draft>): void => setD((p) => ({ ...p, ...patch }));

  useEffect(() => {
    void api()?.routines.triggerInfo().then(setTrig);
    void api()?.connectors.options().then(setServers).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api()
      ?.routines.cronPreview(d.cron)
      .then((r) => {
        if (cancelled) return;
        setPreview(
          r.valid
            ? `${r.human}${r.next ? ` · next ${new Date(r.next).toLocaleString()}` : ""}`
            : "Invalid cron expression",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [d.cron]);

  const save = async (): Promise<void> => {
    setBusy(true);
    const trigger =
      d.triggerKind === "schedule"
        ? { kind: "schedule" as const, cron: d.cron }
        : d.triggerKind === "webhook"
          ? { kind: "webhook" as const, webhookId: d.webhookId }
          : d.triggerKind === "event"
            ? {
                kind: "event" as const,
                event: {
                  connector: d.eventConnector,
                  type: d.eventType,
                  intervalMinutes: d.eventInterval,
                  filter: d.eventFilter.trim() || undefined,
                },
              }
            : { kind: "manual" as const };
    const input = {
      name: d.name.trim() || "New routine",
      prompt: d.prompt.trim(),
      space: d.space,
      connectors: d.connectors,
      trigger,
      condition: d.condition.trim()
        ? { kind: "agent" as const, prompt: d.condition.trim() }
        : { kind: "always" as const },
      output:
        d.outputKind === "connector"
          ? { kind: "connector" as const, connector: d.outputConnector }
          : { kind: d.outputKind },
      enabled: d.enabled,
    };
    try {
      if (d.id) await api()?.routines.update(d.id, input);
      else await api()?.routines.create(input);
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={d.id ? "Edit routine" : "New routine"}>
      <div className="space-y-3">
        <input
          value={d.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Routine name"
          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/30"
        />
        <div>
          <label className="text-xs text-muted-foreground">Instruction (runs each time)</label>
          <textarea
            value={d.prompt}
            onChange={(e) => set({ prompt: e.target.value })}
            rows={4}
            placeholder="e.g. Summarize my open PRs and what needs attention."
            className="mt-1 w-full resize-none rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/30"
          />
        </div>
        <div className="flex items-center gap-4">
          <div>
            <label className="text-xs text-muted-foreground">Trigger</label>
            <div className="mt-1 flex rounded-md border border-border p-0.5">
              {(["schedule", "event", "webhook", "manual"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => set({ triggerKind: k })}
                  className={cn(
                    "rounded px-2.5 py-1.5 text-xs font-medium capitalize",
                    d.triggerKind === k ? "bg-card shadow-sm" : "text-muted-foreground",
                  )}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Space</label>
            <div className="mt-1 flex rounded-md border border-border p-0.5">
              {(["code", "home"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => set({ space: s })}
                  className={cn(
                    "rounded px-2.5 py-1.5 text-xs font-medium capitalize",
                    d.space === s ? "bg-card shadow-sm" : "text-muted-foreground",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>

        {d.triggerKind === "schedule" && (
          <SchedulePicker
            cron={d.cron}
            human={preview}
            onChange={(c) => set({ cron: c })}
          />
        )}
        {d.triggerKind === "webhook" && (
          <div className="rounded-md border border-border bg-muted/40 p-2.5 text-[12px]">
            {d.webhookId && trig ? (
              <>
                <div className="text-muted-foreground">POST this URL to run it:</div>
                <code className="mt-1 block break-all font-mono text-[11px]">
                  {trig.baseUrl}/webhook/{d.webhookId}
                </code>
              </>
            ) : (
              <span className="text-muted-foreground">
                Save first — the webhook URL is generated on create. External
                services need a tunnel (ngrok/cloudflared) to reach it.
              </span>
            )}
          </div>
        )}
        {d.triggerKind === "event" && (
          <div className="space-y-2 rounded-md border border-border bg-muted/40 p-2.5">
            <p className="text-[12px] text-muted-foreground">
              Polls a connector and runs only when something new appears
              (otherwise it skips). Needs the connector selected below.
            </p>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-xs text-muted-foreground">Connector</label>
                <select
                  value={d.eventConnector}
                  onChange={(e) => set({ eventConnector: e.target.value })}
                  className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-2 text-sm outline-none focus:border-foreground/30"
                >
                  <option value="">Any connected</option>
                  {servers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="w-24">
                <label className="text-xs text-muted-foreground">Every (min)</label>
                <input
                  type="number"
                  min={1}
                  value={d.eventInterval}
                  onChange={(e) => set({ eventInterval: Number(e.target.value) || 15 })}
                  className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-2 text-sm outline-none focus:border-foreground/30"
                />
              </div>
            </div>
            <input
              value={d.eventType}
              onChange={(e) => set({ eventType: e.target.value })}
              placeholder="Event to watch — e.g. merged pull request, new critical error"
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/30"
            />
          </div>
        )}
        {d.triggerKind === "manual" && (
          <p className="text-[12px] text-muted-foreground">
            Runs only when you press Run, or via the API below.
          </p>
        )}
        {d.id && trig && (
          <div className="rounded-md border border-border bg-muted/40 p-2.5 text-[11px] text-muted-foreground">
            API: <code className="font-mono">POST {trig.baseUrl}/run/{d.id}</code>{" "}
            with header{" "}
            <code className="font-mono">Authorization: Bearer {trig.apiKey}</code>
          </div>
        )}
        <div>
          <label className="text-xs text-muted-foreground">Output</label>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border border-border p-0.5">
              {(["chat", "notification", "connector"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => set({ outputKind: k })}
                  className={cn(
                    "rounded px-2.5 py-1.5 text-xs font-medium capitalize",
                    d.outputKind === k ? "bg-card shadow-sm" : "text-muted-foreground",
                  )}
                >
                  {k}
                </button>
              ))}
            </div>
            {d.outputKind === "connector" && (
              <select
                value={d.outputConnector}
                onChange={(e) => set({ outputConnector: e.target.value })}
                className="rounded-md border border-border bg-transparent px-2 py-2 text-sm outline-none focus:border-foreground/30"
              >
                <option value="">Pick a connector</option>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            )}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {d.outputKind === "chat"
              ? "Each run opens a new chat with the result."
              : d.outputKind === "notification"
                ? "A native notification with the result (a chat is still saved)."
                : "The agent posts the result to the connector (a chat is still saved)."}
          </p>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">
            Condition (optional) — run only if this holds; the agent checks it first
          </label>
          <input
            value={d.condition}
            onChange={(e) => set({ condition: e.target.value })}
            placeholder="e.g. there are new critical Sentry errors"
            className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/30"
          />
        </div>
        {servers.length > 0 && (
          <div>
            <label className="text-xs text-muted-foreground">
              Connectors — tools this routine may use (none selected = all)
            </label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {servers.map((s) => {
                const on = d.connectors.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    title={s.kind === "mcp" ? "Raw MCP server" : "Connector"}
                    onClick={() =>
                      set({
                        connectors: on
                          ? d.connectors.filter((x) => x !== s.id)
                          : [...d.connectors, s.id],
                      })
                    }
                    className={cn(
                      "rounded-md border px-2 py-1 text-xs transition-colors",
                      on
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.05]",
                    )}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="flex items-center justify-between border-t border-border pt-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={d.enabled} onChange={(v) => set({ enabled: v })} />
            Enabled
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !d.prompt.trim()}
              className="flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60"
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              Save
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ─── Schedule picker (human-friendly cron) ─────────────────────────────────

type SchedMode = "hourly" | "daily" | "weekdays" | "weekly" | "custom";
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SCHED_LABEL: Record<SchedMode, string> = {
  hourly: "Hourly",
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  custom: "Custom",
};
const pad = (n: number): string => String(n).padStart(2, "0");

function schedToCron(mode: SchedMode, time: string, weekday: number): string {
  const [h, m] = time.split(":").map((x) => Number(x) || 0);
  switch (mode) {
    case "hourly":
      return `${m} * * * *`;
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${weekday}`;
    default:
      return "";
  }
}

function cronToSched(cron: string): {
  mode: SchedMode;
  time: string;
  weekday: number;
} {
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return { mode: "custom", time: "09:00", weekday: 1 };
  const [min, hr, dom, mon, dow] = p;
  const m = Number(min);
  const h = Number(hr);
  if (hr === "*" && Number.isFinite(m))
    return { mode: "hourly", time: `09:${pad(m)}`, weekday: 1 };
  if (!Number.isFinite(m) || !Number.isFinite(h))
    return { mode: "custom", time: "09:00", weekday: 1 };
  const time = `${pad(h)}:${pad(m)}`;
  if (dom === "*" && mon === "*") {
    if (dow === "1-5") return { mode: "weekdays", time, weekday: 1 };
    if (dow === "*") return { mode: "daily", time, weekday: 1 };
    if (/^[0-6]$/.test(dow)) return { mode: "weekly", time, weekday: Number(dow) };
  }
  return { mode: "custom", time, weekday: 1 };
}

function SchedulePicker({
  cron,
  human,
  onChange,
}: {
  cron: string;
  human: string;
  onChange: (cron: string) => void;
}): JSX.Element {
  const init = cronToSched(cron);
  const [mode, setMode] = useState<SchedMode>(init.mode);
  const [time, setTime] = useState(init.time);
  const [weekday, setWeekday] = useState(init.weekday);

  const apply = (m: SchedMode, t: string, w: number): void => {
    setMode(m);
    setTime(t);
    setWeekday(w);
    if (m !== "custom") onChange(schedToCron(m, t, w));
  };

  return (
    <div>
      <label className="text-xs text-muted-foreground">Schedule</label>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {(["hourly", "daily", "weekdays", "weekly", "custom"] as SchedMode[]).map(
          (k) => (
            <button
              key={k}
              type="button"
              onClick={() => apply(k, time, weekday)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                mode === k
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.05]",
              )}
            >
              {SCHED_LABEL[k]}
            </button>
          ),
        )}
      </div>

      {mode !== "hourly" && mode !== "custom" && (
        <div className="mt-2 flex items-end gap-2">
          <div>
            <label className="text-xs text-muted-foreground">Time</label>
            <input
              type="time"
              value={time}
              onChange={(e) => apply(mode, e.target.value, weekday)}
              className="mt-1 block rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/30"
            />
          </div>
          {mode === "weekly" && (
            <div>
              <label className="text-xs text-muted-foreground">Day</label>
              <select
                value={weekday}
                onChange={(e) => apply(mode, time, Number(e.target.value))}
                className="mt-1 block rounded-md border border-border bg-transparent px-2 py-2 text-sm outline-none focus:border-foreground/30"
              >
                {DOW.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {mode === "custom" && (
        <input
          value={cron}
          onChange={(e) => onChange(e.target.value)}
          placeholder="minute hour day month weekday"
          className="mt-2 w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-sm outline-none focus:border-foreground/30"
        />
      )}

      <p className="mt-1.5 text-[11px] text-muted-foreground">{human}</p>
    </div>
  );
}
