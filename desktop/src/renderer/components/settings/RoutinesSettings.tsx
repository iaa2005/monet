/**
 * Routines — templated agent tasks kicked off on a schedule (cron), manually,
 * or by webhook/connector event. Draft one from natural language, start from a
 * template, or hand-edit. Each run produces a new chat.
 *
 * The shape is Cursor's automations editor, deliberately: a LIST of routines,
 * and a DETAIL page that replaces it inside the same panel — never a modal.
 * The detail page reads as sections (Triggers / Instructions / Tools /
 * Output), with the trigger written as a human sentence whose blanks are the
 * controls, and a Run History tab with the last runs and their outcomes.
 */
import { useEffect, useMemo, useState } from "react";
import {
  AlarmClock,
  Plus,
  Brain,
  Blocks,
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
  ArrowLeft,
  ChevronRight,
  CalendarClock,
  Webhook,
  Radio,
  Hand,
  type LucideIcon,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Select, TimeSelect } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MicButton } from "@/components/chat/MicButton";
import { ServiceIcon } from "@/components/directory/shared";
import { useChatStore } from "@/stores/chatStore";
import { cn } from "@/lib/utils";
import { ErrorMark } from "@/components/ErrorMark";
import type {
  ElectronAPI,
  Routine,
  RoutineRun,
  UiConnectorService,
} from "@/types/electron";
import { SectionTitle } from "@/components/settings/SectionTitle";

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
  grants: string[];
  providerId: string;
  model: string;
  outputKind: "chat" | "notification" | "connector";
  outputConnector: string;
  condition: string;
  memory: boolean;
  /** Where runs land: a fresh chat per run, or one continuous chat that
   * keeps its context between runs. */
  chatMode: "new" | "continuous";
  /** continuous: compact the shared chat every N runs; 0 = never. */
  compactEvery: number;
  enabled: boolean;
}

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
  return { name: "", prompt: "", space: "code", triggerKind: "schedule", cron: "0 9 * * 1-5", eventConnector: "", eventType: "", eventInterval: 15, eventFilter: "", connectors: [], grants: [], providerId: "", model: "", outputKind: "chat", outputConnector: "", condition: "", memory: true, chatMode: "new", compactEvery: 0, enabled: true };
}

function draftFromRoutine(r: RoutineRow): Draft {
  return {
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
    grants: r.grants ?? [],
    providerId: r.providerId ?? "",
    model: r.model ?? "",
    outputKind: r.output?.kind ?? "chat",
    outputConnector: r.output?.connector ?? "",
    condition: r.condition?.prompt ?? "",
    memory: r.memory !== false,
    chatMode: r.chat === "continuous" ? "continuous" : "new",
    compactEvery: r.compactEvery ?? 0,
    enabled: r.enabled,
  };
}

/** The one-line description a routine row shows for its trigger. */
function triggerSentence(r: RoutineRow): string {
  if (r.trigger.kind === "schedule")
    return r.humanSchedule ?? r.trigger.cron ?? "on a schedule";
  if (r.trigger.kind === "event")
    return `every ${r.trigger.event?.intervalMinutes ?? 15}m · ${r.trigger.event?.type || r.trigger.event?.connector || "connector event"}`;
  if (r.trigger.kind === "webhook") return "on webhook";
  return "manual";
}

const SECTION =
  "text-[11px] font-medium uppercase tracking-wider text-muted-foreground";
const CARD = "rounded-lg border border-border bg-card";
const FIELD =
  "rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-foreground/30";

export function RoutinesSettings({
  onOpenChat,
}: {
  onOpenChat?: (sessionId: string) => void;
} = {}): JSX.Element {
  const [routines, setRoutines] = useState<RoutineRow[]>([]);
  const [desc, setDesc] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
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
    setDraftError(null);
    try {
      const r = await api()?.routines.draft(text.trim(), "code");
      if (r?.ok && r.draft)
        setEditor({
          ...emptyDraft(),
          name: r.draft.name,
          prompt: r.draft.prompt,
          cron: r.draft.cron,
          space: r.draft.space,
          ...(r.draft.connectors ? { connectors: r.draft.connectors } : {}),
          ...(r.draft.grants ? { grants: r.draft.grants } : {}),
          ...(r.draft.output
            ? {
                outputKind: r.draft.output.kind,
                outputConnector: r.draft.output.connector ?? "",
              }
            : {}),
        });
      else {
        // Falling back to a bare prompt is fine, but doing it SILENTLY made a
        // failed draft look like a working feature that just ignores the cron,
        // connectors and output. Say what went wrong.
        setEditor({ ...emptyDraft(), prompt: text.trim() });
        setDraftError(
          r?.error
            ? `Couldn't draft the rest of the routine: ${r.error} — the description was kept, fill in the schedule yourself.`
            : "Couldn't draft the rest of the routine — the description was kept, fill in the schedule yourself.",
        );
      }
    } finally {
      setDrafting(false);
    }
  };

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

  // ── Detail page replaces the list inside the same panel ─────────────
  if (editor)
    return (
      <RoutineDetail
        draft={editor}
        onBack={() => {
          setEditor(null);
          load();
        }}
        onSaved={(saved) => {
          setEditor(saved);
          setDesc("");
          load();
        }}
        onDeleted={() => {
          setEditor(null);
          load();
        }}
        onOpenChat={onOpenChat}
        runningId={runningId}
        onRunNow={runNow}
      />
    );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <SectionTitle className="flex items-center gap-2">
            <AlarmClock className="size-6" />
            Routines
          </SectionTitle>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Agent tasks that run on a schedule, webhook, or connector event.
            Each run opens a chat with the result.
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
      <div className={cn(CARD, "glass-panel p-3")}>
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="What do you want automated?"
          rows={2}
          className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {/* No canned prompts. The templates below are the real answer to "what
            can this do" — three examples about pull requests sitting above
            them said this was a tool for one kind of work, and filled the box
            with someone else's routine. */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <div className="ml-auto flex items-center gap-1.5">
            <MicButton
              // Down: this mic is near the top of the panel, and the default
              // upward panel would open off the top of the screen.
              side="bottom"
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
        {draftError && (
          <p className="mt-2 text-xs text-destructive">{draftError}</p>
        )}
      </div>

      {/* Existing routines */}
      {routines.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1 py-10 text-muted-foreground">
          <Clock className="size-6" />
          <span className="text-sm">No routines yet.</span>
        </div>
      ) : (
        <div className={cn(CARD, "glass-panel divide-y divide-border")}>
          {routines.map((r) => (
            <div key={r.id} className="group flex items-center gap-3 px-3 py-2.5">
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
                onClick={() => setEditor(draftFromRoutine(r))}
                className="min-w-0 flex-1 text-left"
              >
                <div className="truncate text-sm font-medium">{r.name}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="size-3" />
                  {triggerSentence(r)}
                  {r.lastStatus === "error" ? (
                    <ErrorMark title="Last run failed" className="size-3" />
                  ) : (
                    r.lastStatus && <StatusPill status={r.lastStatus} />
                  )}
                </div>
              </button>
              <button
                type="button"
                onClick={() => void runNow(r.id)}
                disabled={runningId === r.id}
                title="Run now"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-black/[0.05] hover:text-foreground group-hover:opacity-100 dark:hover:bg-white/[0.06]"
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
              <ChevronRight className="size-4 shrink-0 text-muted-foreground/50" />
            </div>
          ))}
        </div>
      )}

      {/* Templates */}
      <div>
        <div className={cn(SECTION, "mb-2")}>Start from a template</div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() =>
                setEditor({ ...emptyDraft(), name: t.name, prompt: t.prompt, cron: t.cron, space: t.space })
              }
              className={cn(
                CARD,
                "glass-panel glass-hover flex min-h-24 flex-col justify-between p-3 text-left transition-colors",
              )}
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
    </div>
  );
}

function StatusPill({ status }: { status: RoutineRun["status"] }): JSX.Element {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10px] font-medium",
        status === "ok" && "bg-green-bg text-green-text",
        status === "error" && "bg-red-bg text-red-text",
        status === "running" && "bg-link/10 text-link",
        status === "skipped" && "bg-muted text-muted-foreground",
      )}
    >
      {status === "ok" ? "Succeeded" : status === "error" ? "Failed" : status}
    </span>
  );
}

// ─── Detail page: Settings | Run History, Cursor-style ─────────────────────

const TRIGGER_META: Record<
  Draft["triggerKind"],
  { icon: LucideIcon; label: string }
> = {
  schedule: { icon: CalendarClock, label: "Schedule" },
  event: { icon: Radio, label: "Connector event" },
  webhook: { icon: Webhook, label: "Webhook" },
  manual: { icon: Hand, label: "Manual" },
};

function RoutineDetail({
  draft,
  onBack,
  onSaved,
  onDeleted,
  onOpenChat,
  runningId,
  onRunNow,
}: {
  draft: Draft;
  onBack: () => void;
  onSaved: (saved: Draft) => void;
  onDeleted: () => void;
  onOpenChat?: (sessionId: string) => void;
  runningId: string | null;
  onRunNow: (id: string) => Promise<void>;
}): JSX.Element {
  const [d, setD] = useState<Draft>(draft);
  const [tab, setTab] = useState<"settings" | "history">("settings");
  const [preview, setPreview] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(!draft.id);
  const [trig, setTrig] = useState<{ baseUrl: string; apiKey: string } | null>(null);
  // Connector accounts AND raw MCP servers — mcp.list() alone went blank once
  // connectors moved out of mcp-servers.json into the encrypted store.
  const [servers, setServers] = useState<
    { id: string; label: string; kind: "connector" | "mcp" }[]
  >([]);
  const [presets, setPresets] = useState<UiConnectorService[]>([]);
  // Live tool lists for the routine's MCP servers, so grants can name the
  // actual tools instead of one coarse "use the server" switch.
  const [mcpTools, setMcpTools] = useState<
    Record<string, { name: string; description: string }[]>
  >({});
  const [providers, setProviders] = useState<
    { id: string; name: string; model: string; models: { name: string; label?: string }[] }[]
  >([]);

  const set = (patch: Partial<Draft>): void => {
    setDirty(true);
    setD((p) => ({ ...p, ...patch }));
  };

  useEffect(() => {
    void api()?.routines.triggerInfo().then(setTrig);
    void api()?.connectors.options().then(setServers).catch(() => {});
    void api()?.connectors.presets().then(setPresets).catch(() => {});
    void api()
      ?.providers.list()
      .then((list) =>
        setProviders(
          list.map((p) => ({
            id: p.id,
            name: p.name,
            // The provider's own default, for the "Default (…)" option — see
            // the same derivation in AdvancedSettings. Read off a flat field,
            // it named whatever the provider form last wrote rather than the
            // model a routine pinned to this provider would actually get.
            model:
              p.models?.find((m) => m.id === p.activeModelId)?.name ??
              p.models?.[0]?.name ??
              "",
            models: (p.models ?? []).map((m) => ({
              name: m.name,
              label: m.label,
            })),
          })),
        ),
      )
      .catch(() => {});
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

  useEffect(() => {
    const wanted = d.connectors.filter(
      (id) => servers.find((x) => x.id === id)?.kind === "mcp" && !(id in mcpTools),
    );
    for (const id of wanted)
      void api()
        ?.mcp.tools(id)
        .then((tools) => setMcpTools((prev) => ({ ...prev, [id]: tools ?? [] })))
        .catch(() => setMcpTools((prev) => ({ ...prev, [id]: [] })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.connectors, servers]);

  // Grants, grouped by the connectors THIS routine carries: offering a Slack
  // write toggle on a routine that has no Slack was noise pretending to be
  // security. Deselecting a tool hides (not silently deletes) its grants.
  const grantGroups = useMemo(() => {
    const byId = new Map(servers.map((server) => [server.id, server]));
    const groups: {
      id: string;
      label: string;
      svg?: string;
      kind: "connector" | "mcp";
      actions: { id: string; label: string; access: "write" | "destructive" }[];
    }[] = [];
    for (const id of d.connectors) {
      const server = byId.get(id);
      if (!server) continue;
      if (server.kind === "mcp") {
        const tools = mcpTools[id] ?? [];
        groups.push({
          id,
          label: server.label,
          kind: "mcp",
          actions: [
            { id: "mcp.use", label: "All tools on this server", access: "write" },
            ...tools.map((t) => ({
              id: `mcp.use.${t.name}`,
              label: t.name,
              access: "write" as const,
            })),
          ],
        });
        continue;
      }
      const preset = presets.find((p) => p.id === id);
      const actions = (preset?.actions ?? [])
        .filter((a: { access: string }) => a.access !== "read")
        .map((a: { id: string; label: string; access: string }) => ({
          id: a.id,
          label: a.label,
          access: a.access as "write" | "destructive",
        }));
      if (actions.length > 0)
        groups.push({
          id,
          label: preset?.displayName ?? server.label,
          svg: preset?.iconSvg,
          kind: "connector",
          actions,
        });
    }
    return groups;
  }, [presets, servers, d.connectors, mcpTools]);

  const save = async (): Promise<void> => {
    setError("");
    if (d.outputKind === "connector" && !d.outputConnector.trim()) {
      setError("Pick a connector for connector output.");
      return;
    }
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
          ? { kind: "connector" as const, connector: d.outputConnector.trim() }
          : { kind: d.outputKind },
      grants: d.grants,
      providerId: d.providerId || undefined,
      model: d.model || undefined,
      memory: d.memory,
      chat: d.chatMode,
      compactEvery:
        d.chatMode === "continuous" && d.compactEvery > 0
          ? d.compactEvery
          : undefined,
      enabled: d.enabled,
    };
    try {
      const saved = d.id
        ? await api()?.routines.update(d.id, input)
        : await api()?.routines.create(input);
      setDirty(false);
      if (saved)
        onSaved(draftFromRoutine(saved as RoutineRow));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save routine.");
    } finally {
      setBusy(false);
    }
  };

  const TriggerIcon = TRIGGER_META[d.triggerKind].icon;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {/* ── Header: back, title, status line ── */}
      <div>
        <button
          type="button"
          onClick={onBack}
          className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Routines
        </button>
        <input
          value={d.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="New routine"
          className="w-full bg-transparent text-xl font-semibold outline-none placeholder:text-muted-foreground/60"
        />
        <div className="mt-3 flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={d.enabled} onChange={(v) => set({ enabled: v })} />
            <span className={d.enabled ? "" : "text-muted-foreground"}>
              {d.enabled ? "Active" : "Paused"}
            </span>
          </label>
          <span className="text-muted-foreground">·</span>
          <span className="text-sm capitalize text-muted-foreground">{d.space} space</span>
          {d.id && (
            <>
              <span className="text-muted-foreground">·</span>
              <button
                type="button"
                onClick={() => void onRunNow(d.id!)}
                disabled={runningId === d.id}
                className="flex items-center gap-1 text-sm text-link transition-opacity hover:opacity-80 disabled:opacity-50"
              >
                {runningId === d.id ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Play className="size-3.5" />
                )}
                Run now
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="flex items-center gap-1 border-b border-border">
        {(["settings", "history"] as const).map((t) => (
          <button
            key={t}
            type="button"
            disabled={t === "history" && !d.id}
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px border-b-2 px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40",
              tab === t
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "settings" ? "Settings" : "Run History"}
          </button>
        ))}
      </div>

      {tab === "history" && d.id ? (
        <RunHistory routineId={d.id} onOpenChat={onOpenChat} />
      ) : (
        <div className="space-y-5">
          {/* ── Triggers ── */}
          <section>
            <div className={cn(SECTION, "mb-1.5")}>Triggers</div>
            <div className={cn(CARD, "space-y-3 p-3")}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <TriggerIcon className="size-4 shrink-0 text-muted-foreground" />
                <Select
                  ariaLabel="Trigger"
                  value={d.triggerKind}
                  onChange={(v) => set({ triggerKind: v as Draft["triggerKind"] })}
                  options={(Object.keys(TRIGGER_META) as Draft["triggerKind"][]).map(
                    (k) => ({ value: k, label: TRIGGER_META[k].label }),
                  )}
                />
                {d.triggerKind === "schedule" && (
                  <ScheduleSentence cron={d.cron} onChange={(c) => set({ cron: c })} />
                )}
                <span className="text-muted-foreground">in</span>
                <Select
                  ariaLabel="Space"
                  value={d.space}
                  onChange={(v) => set({ space: v as "home" | "code" })}
                  options={[
                    { value: "code", label: "code" },
                    { value: "home", label: "home" },
                  ]}
                />
              </div>
              {d.triggerKind === "schedule" && (
                <p className="pl-6 text-xs text-muted-foreground">{preview}</p>
              )}

              {d.triggerKind === "event" && (
                <div className="space-y-2 pl-6">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-muted-foreground">Watch</span>
                    <Select
                      ariaLabel="Connector to watch"
                      value={d.eventConnector}
                      onChange={(v) => set({ eventConnector: v })}
                      options={[
                        { value: "", label: "any connected" },
                        ...servers.map((x) => ({
                          value: x.id,
                          label:
                            presets.find((p) => p.id === x.id)?.displayName ??
                            x.label,
                          hint: x.kind,
                        })),
                      ]}
                    />
                    <span className="text-muted-foreground">every</span>
                    <input
                      type="number"
                      min={1}
                      value={d.eventInterval}
                      onChange={(e) => set({ eventInterval: Number(e.target.value) || 15 })}
                      className={cn(FIELD, "w-16")}
                    />
                    <span className="text-muted-foreground">minutes</span>
                  </div>
                  <input
                    value={d.eventType}
                    onChange={(e) => set({ eventType: e.target.value })}
                    placeholder="Event to watch — e.g. merged pull request, new critical error"
                    className={cn(FIELD, "w-full px-3 py-2 text-sm")}
                  />
                  <p className="text-xs text-muted-foreground">
                    Runs only when something new appears; otherwise the run is skipped.
                  </p>
                </div>
              )}
              {d.triggerKind === "webhook" && (
                <div className="pl-6 text-xs">
                  {d.webhookId && trig ? (
                    <>
                      <span className="text-muted-foreground">POST this URL to run it: </span>
                      <code className="break-all font-mono text-[11px]">
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
              {d.triggerKind === "manual" && (
                <p className="pl-6 text-xs text-muted-foreground">
                  Runs only when you press Run, or via the API below.
                </p>
              )}

              {/* Condition is part of WHEN it runs, so it lives with the trigger. */}
              <div className="flex items-center gap-2 border-t border-border pt-2.5 text-sm">
                <span className="shrink-0 pl-6 text-muted-foreground">only if</span>
                <input
                  value={d.condition}
                  onChange={(e) => set({ condition: e.target.value })}
                  placeholder="always — or e.g. there are new critical Sentry errors"
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
                />
              </div>
            </div>
          </section>

          {/* ── Instructions ── */}
          <section>
            <div className={cn(SECTION, "mb-1.5")}>Instructions</div>
            <div className={CARD}>
              <textarea
                value={d.prompt}
                onChange={(e) => set({ prompt: e.target.value })}
                rows={6}
                placeholder="What should the agent do each time? e.g. Summarize my open PRs and what needs attention."
                className="w-full resize-none bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground/60"
              />
              <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
                <Select
                  ariaLabel="Provider"
                  value={d.providerId}
                  onChange={(v) => set({ providerId: v, model: "" })}
                  className="max-w-[18rem] border-transparent text-muted-foreground"
                  options={[
                    { value: "", label: "Whatever model is active when it runs" },
                    ...providers.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                />
                {d.providerId && (
                  <Select
                    ariaLabel="Model"
                    value={d.model}
                    onChange={(v) => set({ model: v })}
                    className="max-w-[18rem] border-transparent text-muted-foreground"
                    options={[
                      {
                        value: "",
                        label: providers.find((p) => p.id === d.providerId)?.model
                          ? `Default (${providers.find((p) => p.id === d.providerId)?.model})`
                          : "That provider's default",
                      },
                      ...(providers.find((p) => p.id === d.providerId)?.models ?? []).map(
                        (m) => ({ value: m.name, label: m.label || m.name }),
                      ),
                    ]}
                  />
                )}
              </div>
            </div>
          </section>

          {/* ── Tools & permissions ── */}
          <section>
            <div className={cn(SECTION, "mb-1.5")}>Tools &amp; permissions</div>
            <div className={cn(CARD, "divide-y divide-border")}>
              {/* One card, Cursor's grammar: the rows are exactly what the
                  routine HAS, and each tool carries its own unattended-write
                  switches right under its name. No implicit "empty means
                  everything", no second list to cross-reference. */}
              {d.memory && (
                <div className="flex items-center gap-2.5 px-3 py-2">
                  <Brain className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">Memories</span>
                  <button
                    type="button"
                    onClick={() =>
                      useChatStore.getState().requestOpenSettings("memory")
                    }
                    className="rounded-md border border-border px-2 py-0.5 text-xs font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                  >
                    Manage
                  </button>
                  <button
                    type="button"
                    title="Run without long-term memory"
                    onClick={() => set({ memory: false })}
                    className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              )}
              {d.connectors.map((id) => {
                const server = servers.find((x) => x.id === id);
                const preset = presets.find((p) => p.id === id);
                const svg = preset?.iconSvg;
                const group = grantGroups.find((g) => g.id === id);
                return (
                  <div key={id} className="px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      {server?.kind === "mcp" && !svg ? (
                        <Blocks className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ServiceIcon svg={svg} className="size-4" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {preset?.displayName ?? server?.label ?? id}
                        {!server && (
                          <span className="ml-1.5 text-xs text-destructive">
                            not connected
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        title="Remove from this routine"
                        onClick={() =>
                          set({ connectors: d.connectors.filter((x) => x !== id) })
                        }
                        className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                    {group && group.actions.length > 0 && (
                      <div className="mt-1 space-y-1 pl-[26px]">
                        {group.actions.map((a) => {
                          const destructive = a.access === "destructive";
                          const blanketed =
                            a.id.startsWith("mcp.use.") &&
                            d.grants.includes("mcp.use");
                          const on =
                            (d.grants.includes(a.id) || blanketed) && !destructive;
                          return (
                            <label
                              key={a.id}
                              className={cn(
                                "flex items-center gap-2 text-sm",
                                destructive
                                  ? "text-muted-foreground"
                                  : "cursor-pointer",
                              )}
                              title={
                                destructive
                                  ? "Destructive actions cannot be granted to unattended runs"
                                  : "Allow this write when nobody is watching"
                              }
                            >
                              <span className="min-w-0 flex-1 truncate">
                                {a.label}
                              </span>
                              <span
                                className={cn(
                                  "rounded-full px-2 py-0.5 text-[10px] font-medium",
                                  destructive
                                    ? "bg-red-bg text-red-text"
                                    : "bg-muted text-muted-foreground",
                                )}
                              >
                                {destructive ? "never unattended" : "write"}
                              </span>
                              <Switch
                                checked={on}
                                disabled={destructive || blanketed}
                                onChange={(v) =>
                                  set({
                                    grants: v
                                      ? [...d.grants, a.id]
                                      : d.grants.filter((x) => x !== a.id),
                                  })
                                }
                              />
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-black/[0.03] hover:text-foreground dark:hover:bg-white/[0.04]"
                  >
                    <Plus className="size-4" />
                    Add Connector or MCP
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72">
                  {!d.memory && (
                    <DropdownMenuItem onClick={() => set({ memory: true })}>
                      <Brain className="size-4 shrink-0" />
                      Memories
                    </DropdownMenuItem>
                  )}
                  {servers
                    .filter((x) => !d.connectors.includes(x.id))
                    .map((x) => {
                      const preset = presets.find((p) => p.id === x.id);
                      const svg = preset?.iconSvg;
                      return (
                        <DropdownMenuItem
                          key={x.id}
                          onClick={() =>
                            set({ connectors: [...d.connectors, x.id] })
                          }
                        >
                          {x.kind === "mcp" && !svg ? (
                            <Blocks className="size-4 shrink-0" />
                          ) : (
                            <ServiceIcon svg={svg} className="size-4" />
                          )}
                          {preset?.displayName ?? x.label}
                          <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground/60">
                            {x.kind}
                          </span>
                        </DropdownMenuItem>
                      );
                    })}
                  {(servers.filter((x) => !d.connectors.includes(x.id)).length > 0 ||
                    !d.memory) && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    onClick={() =>
                      useChatStore.getState().requestOpenSettings("connectors")
                    }
                  >
                    <Plus className="size-4 shrink-0" />
                    Connect a new service…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <p className="px-3 py-2 text-xs text-muted-foreground">
                Reads are always allowed. Writes run unattended only when
                switched on; destructive actions never do. Connector-level Deny
                still takes precedence.
              </p>
            </div>
          </section>

          {/* ── Output ── */}
          <section>
            <div className={cn(SECTION, "mb-1.5")}>Output</div>
            <div className={cn(CARD, "space-y-2 p-3")}>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-md border border-border p-0.5">
                  {(["chat", "notification", "connector"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => set({ outputKind: k })}
                      className={cn(
                        "rounded px-2.5 py-1 text-xs font-medium capitalize",
                        d.outputKind === k
                          ? "bg-black/[0.06] dark:bg-white/[0.08]"
                          : "text-muted-foreground",
                      )}
                    >
                      {k}
                    </button>
                  ))}
                </div>
                {d.outputKind === "connector" && (
                  <Select
                    ariaLabel="Output connector"
                    value={d.outputConnector}
                    onChange={(v) => set({ outputConnector: v })}
                    placeholder="Pick a connector"
                    options={servers.map((x) => ({
                      value: x.id,
                      label:
                        presets.find((p) => p.id === x.id)?.displayName ?? x.label,
                      hint: x.kind,
                    }))}
                  />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {d.outputKind === "chat"
                  ? "The result lands in the routine's chat."
                  : d.outputKind === "notification"
                    ? "A native notification with the result (a chat is still saved)."
                    : "The agent posts the result to the connector (a chat is still saved)."}
              </p>

              {/* Where the runs live: a chat per run, or one chat that
                  REMEMBERS — run N+1 opens with run N's context. */}
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
                <div className="flex rounded-md border border-border p-0.5">
                  {(
                    [
                      ["new", "New chat per run"],
                      ["continuous", "One continuous chat"],
                    ] as const
                  ).map(([k, labelText]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => set({ chatMode: k })}
                      className={cn(
                        "rounded px-2.5 py-1 text-xs font-medium",
                        d.chatMode === k
                          ? "bg-black/[0.06] dark:bg-white/[0.08]"
                          : "text-muted-foreground",
                      )}
                    >
                      {labelText}
                    </button>
                  ))}
                </div>
                {d.chatMode === "continuous" && (
                  <Select
                    ariaLabel="Compact the chat"
                    value={String(d.compactEvery)}
                    onChange={(v) => set({ compactEvery: Number(v) || 0 })}
                    options={[
                      { value: "0", label: "Compact: never" },
                      { value: "5", label: "Compact every 5 runs" },
                      { value: "10", label: "Compact every 10 runs" },
                      { value: "25", label: "Compact every 25 runs" },
                      { value: "50", label: "Compact every 50 runs" },
                    ]}
                  />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {d.chatMode === "continuous"
                  ? "Every run continues the same chat, so the agent remembers previous runs. Condition checks stay visible but are kept out of the model's context."
                  : "Every run starts fresh, with no memory of previous runs."}
              </p>
            </div>
          </section>

          {/* ── API access ── */}
          {d.id && trig && (
            <section>
              <div className={cn(SECTION, "mb-1.5")}>API</div>
              <div className={cn(CARD, "p-3 text-[11px] text-muted-foreground")}>
                <code className="font-mono">POST {trig.baseUrl}/run/{d.id}</code> with
                header <code className="font-mono">Authorization: Bearer {trig.apiKey}</code>
              </div>
            </section>
          )}

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}

          {/* ── Footer: save / delete ── */}
          <div className="flex items-center justify-between border-t border-border pt-3">
            {d.id ? (
              <button
                type="button"
                onClick={() => {
                  void api()?.routines.delete(d.id!);
                  onDeleted();
                }}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-4" />
                Delete routine
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              {dirty && (
                <span className="text-xs text-muted-foreground">Unsaved changes</span>
              )}
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy || !d.prompt.trim() || !dirty}
                className="flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60"
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                {d.id ? "Save changes" : "Create routine"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Run history tab ───────────────────────────────────────────────────────

function RunHistory({
  routineId,
  onOpenChat,
}: {
  routineId: string;
  onOpenChat?: (sessionId: string) => void;
}): JSX.Element {
  const [runs, setRuns] = useState<RoutineRun[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void api()
        ?.routines.listRuns(routineId)
        .then((r) => {
          if (!cancelled) setRuns(r ?? []);
        })
        .catch(() => {});
    };
    load();
    const off = api()?.routines.onRan(() => load());
    return () => {
      cancelled = true;
      off?.();
    };
  }, [routineId]);

  const stats = useMemo(() => {
    const now = Date.now();
    const ok = (ms: number): number =>
      (runs ?? []).filter(
        (r) => r.status === "ok" && now - new Date(r.at).getTime() <= ms,
      ).length;
    return [
      { label: "Last 1h", value: ok(3600_000) },
      { label: "Last 24h", value: ok(24 * 3600_000) },
      { label: "Last 7d", value: ok(7 * 24 * 3600_000) },
    ];
  }, [runs]);

  if (runs === null)
    return <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        {stats.map((s) => (
          <div key={s.label} className={cn(CARD, "p-3")}>
            <div className="text-xs text-muted-foreground">{s.label}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{s.value}</div>
            <div className="text-xs text-muted-foreground">Succeeded</div>
          </div>
        ))}
      </div>

      {runs.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No runs yet — press Run now, or wait for the trigger.
        </p>
      ) : (
        <div className={cn(CARD, "divide-y divide-border")}>
          <div className="grid grid-cols-[8.5rem_6rem_1fr_2rem] items-center gap-2 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <span>Date</span>
            <span>Status</span>
            <span>Result</span>
            <span />
          </div>
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              disabled={!run.sessionId || !onOpenChat}
              onClick={() => {
                if (run.sessionId && onOpenChat) onOpenChat(run.sessionId);
              }}
              className="grid w-full grid-cols-[8.5rem_6rem_1fr_2rem] items-center gap-2 px-3 py-2 text-left text-sm transition-colors enabled:hover:bg-black/[0.03] enabled:dark:hover:bg-white/[0.04]"
            >
              <span className="tabular-nums text-muted-foreground">
                {new Date(run.at).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span>
                <StatusPill status={run.status} />
              </span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {run.error ?? run.summary ?? (run.sessionId ? "Open the chat" : "—")}
              </span>
              <span className="text-muted-foreground/50">
                {run.sessionId && onOpenChat && <ExternalLink className="size-3.5" />}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Schedule sentence (human-friendly cron, inline) ───────────────────────

type SchedMode = "hourly" | "daily" | "weekdays" | "weekly" | "custom";
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SCHED_LABEL: Record<SchedMode, string> = {
  hourly: "Every hour",
  daily: "Every day",
  weekdays: "Every weekday",
  weekly: "Every week",
  custom: "Custom (cron)",
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

/**
 * The schedule as a SENTENCE whose blanks are the controls —
 * "[Every day] at [06:00]" — the way Cursor writes its trigger row.
 */
function ScheduleSentence({
  cron,
  onChange,
}: {
  cron: string;
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
    <>
      <Select
        ariaLabel="How often"
        value={mode}
        onChange={(v) => apply(v as SchedMode, time, weekday)}
        options={(Object.keys(SCHED_LABEL) as SchedMode[]).map((k) => ({
          value: k,
          label: SCHED_LABEL[k],
        }))}
      />
      {mode === "weekly" && (
        <>
          <span className="text-muted-foreground">on</span>
          <Select
            ariaLabel="Day of week"
            value={String(weekday)}
            onChange={(v) => apply(mode, time, Number(v))}
            options={DOW.map((day, i) => ({ value: String(i), label: day }))}
          />
        </>
      )}
      {mode !== "hourly" && mode !== "custom" && (
        <>
          <span className="text-muted-foreground">at</span>
          <TimeSelect value={time} onChange={(t) => apply(mode, t, weekday)} />
        </>
      )}
      {mode === "custom" && (
        <input
          value={cron}
          onChange={(e) => onChange(e.target.value)}
          placeholder="min hour day month weekday"
          className={cn(FIELD, "font-mono")}
        />
      )}
    </>
  );
}
