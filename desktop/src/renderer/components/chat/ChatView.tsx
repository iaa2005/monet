import { useEffect, useState, useMemo, useRef, memo } from "react";
import { useChatStore } from "@/stores/chatStore";
import { MarkdownViewer } from "./MarkdownViewer";
import { ToolCallBubble } from "./ToolCallBubble";
import { MessageInput } from "./MessageInput";
import { TodoCard } from "./TodoCard";
import { GitCard } from "./GitCard";
import { PermissionDialog } from "./PermissionDialog";
import { AskUserDialog } from "./AskUserDialog";
import { Modal } from "@/components/ui/modal";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "@/components/ui/message-scroller";
import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Shimmer } from "@/components/ui/shimmer";
import { StatsDashboard } from "@/components/StatsDashboard";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import {
  Bug,
  Check,
  Copy,
  FileSearch,
  FlaskConical,
  GitPullRequest,
  History,
  Loader2,
  Pencil,
  Play,
  RotateCcw,
  Clock,
  Brain,
  X as XIcon,
  type LucideIcon,
} from "lucide-react";
import {
  ArtifactThumb,
  ArtifactsStrip,
  KindIcon,
  viewArtifact,
} from "@/components/ArtifactsPanel";
import {
  sandboxFilesFromOutput,
  type ArtifactItem,
} from "@/lib/sessionArtifacts";
import { cn } from "@/lib/utils";
import greetings from "@/data/greetings.json";
import type {
  ElectronAPI,
  PermissionRequest,
  AskUserRequest,
} from "@/types/electron";
import type { ChatMessage, ToolCall } from "@/types/chat";

type TranscriptMode = "normal" | "thinking" | "verbose" | "summary";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/** Home-screen suggestion chips (coding-agent flavored). Clicking one prefills
 * the composer via the store's composerDraft. */
const IDEAS: { icon: LucideIcon; label: string; prompt: string }[] = [
  {
    icon: FileSearch,
    label: "Explain this codebase",
    prompt:
      "Give me a high-level overview of this codebase — its structure, the main modules, and how they fit together.",
  },
  {
    icon: Bug,
    label: "Find and fix a bug",
    prompt:
      "Look through the code for a likely bug, fix it, and explain what was wrong.",
  },
  {
    icon: FlaskConical,
    label: "Write tests",
    prompt: "Pick an important module and write unit tests for it.",
  },
  {
    icon: GitPullRequest,
    label: "Review my recent changes",
    prompt:
      "Review my most recent changes (git diff) for correctness, bugs, and quality.",
  },
];

function WorkingRow(): JSX.Element {
  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="ghost">
          <BubbleContent>
            <Shimmer>Working…</Shimmer>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

/** Attachment chips / thumbnails shown on a user message. Image previews
 * re-read the on-disk artifact when the in-memory data URL is gone; clicking
 * anything with a saved path opens it with the OS. */
function AttachmentChips({
  attachments,
}: {
  attachments: NonNullable<ChatMessage["attachments"]>;
}): JSX.Element {
  return (
    <div className="mb-1 flex flex-wrap justify-end gap-1.5">
      {attachments.map((a, i) =>
        a.kind === "image" && (a.dataUrl || a.path) ? (
          <ArtifactThumb
            key={`${i}-${a.name}`}
            a={a}
            onClick={() => viewArtifact(a)}
            className="max-h-44 max-w-60 rounded-lg border border-border object-cover"
          />
        ) : (
          <button
            key={`${i}-${a.name}`}
            type="button"
            title={a.path ? `View ${a.name}` : a.name}
            onClick={() => viewArtifact(a)}
            disabled={!a.path}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground transition-colors enabled:hover:text-foreground disabled:cursor-default"
          >
            <KindIcon kind={a.kind} className="size-3" />
            <span className="max-w-44 truncate">{a.name}</span>
          </button>
        ),
      )}
    </div>
  );
}

/** Code "Rewind to here", shown under a USER message: reverts the workspace to
 * the state BEFORE this turn and drops the prompt back into the composer to edit
 * and resend. Previews how much the revert would undo (files, +ins/-del) on
 * hover. */
function RewindControl({ messageId }: { messageId: string }): JSX.Element {
  const rewindAndEdit = useChatStore((s) => s.rewindAndEdit);
  const sessionId = useChatStore((s) => s.currentSessionId);
  // The checkpoint to restore to = the most recent assistant checkpoint BEFORE
  // this user message (the workspace state before this turn ran).
  const sha = useChatStore((s) => {
    const msgs = s.messages;
    const idx = msgs.findIndex((m) => m.id === messageId);
    if (idx < 0) return undefined;
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].checkpointSha) return msgs[i].checkpointSha;
    }
    return undefined;
  });
  const [stat, setStat] = useState<{
    files: number;
    insertions: number;
    deletions: number;
  } | null>(null);
  const [fetched, setFetched] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const loadStat = (): void => {
    if (fetched || !sha) return;
    setFetched(true);
    void window.electronAPI?.checkpoints
      .diffStat(sessionId ?? "default", sha)
      .then((s) => setStat(s ?? null))
      .catch(() => {});
  };

  const hasChanges = !!stat && stat.files > 0;
  return (
    <div
      className="mt-0.5 flex opacity-0 transition-opacity group-hover:opacity-100"
      onMouseEnter={loadStat}
    >
      <button
        type="button"
        title={
          hasChanges
            ? `Rewind to here — reverts the workspace (undoing ${stat!.files} changed ${stat!.files === 1 ? "file" : "files"}, +${stat!.insertions}/-${stat!.deletions}) and puts this prompt back in the composer to edit and resend`
            : "Rewind to here — revert the workspace to before this turn and put this prompt back in the composer to edit and resend"
        }
        onClick={() => setConfirmOpen(true)}
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
      >
        <History className="size-3" />
        Rewind to here
        {hasChanges && (
          <span className="ml-0.5 tabular-nums text-[10px] text-muted-foreground/80">
            {stat!.files}f{" "}
            <span className="text-green-text">+{stat!.insertions}</span>
            <span className="text-red-text"> -{stat!.deletions}</span>
          </span>
        )}
      </button>
      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Rewind to checkpoint?"
      >
        <p className="text-sm text-muted-foreground">
          This will restore the workspace to before this turn and put the prompt
          back in the composer for editing and resubmission.
          {hasChanges && (
            <> This will undo {stat!.files} changed {stat!.files === 1 ? "file" : "files"} (+{stat!.insertions}/-{stat!.deletions}).</>
          )}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setConfirmOpen(false)}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmOpen(false);
              void rewindAndEdit(messageId);
            }}
            className="rounded-lg bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground transition-opacity hover:opacity-90"
          >
            Rewind
          </button>
        </div>
      </Modal>
    </div>
  );
}

/** Memoized so a streaming flush only re-renders the message that changed —
 * finished messages keep their object identity in the store, so re-parsing
 * their markdown (the main scroll-lag source) is skipped entirely. */
/** Thinking mode: the model's reasoning, shown in a muted collapsible block
 * above the answer. Display-only — this text never re-enters the model context.
 * Open while streaming (so you watch it think), collapsible once the answer
 * lands. */
function ReasoningBlock({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}): JSX.Element {
  return (
    <details
      open={streaming}
      className="mb-1.5 rounded-lg border border-border/60 bg-black/[0.02] px-3 py-2 dark:bg-white/[0.03]"
    >
      <summary className="flex cursor-pointer select-none items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
        <Brain className="size-3.5" />
        {streaming ? "Thinking…" : "Thought process"}
      </summary>
      <div className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
        {text}
      </div>
    </details>
  );
}

const MessageRow = memo(
  function MessageRow({
    msg,
    mode,
  }: {
    msg: ChatMessage;
    mode?: TranscriptMode;
  }): JSX.Element {
    const isStreaming = useChatStore((s) => s.isStreaming);
    const home = useChatStore((s) => s.space === "home");
    const resendFrom = useChatStore((s) => s.resendFrom);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(msg.content);

    if (msg.role === "tool" && msg.toolCall) {
      return <ToolCallBubble toolCall={msg.toolCall} mode={mode} />;
    }

    const isUser = msg.role === "user";
    // Edit/Retry rewind the conversation, so only offer them in Home (Code gets
    // filesystem-aware Rewind) and never mid-stream.
    const canAct = isUser && home && !isStreaming;

    const saveEdit = (): void => {
      const t = draft.trim();
      setEditing(false);
      if (t && t !== msg.content) void resendFrom(msg.id, t);
    };

    if (isUser && editing) {
      return (
        <Message align="end">
          <MessageContent>
            <div className="w-full min-w-[18rem] rounded-2xl border border-border bg-card p-2">
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditing(false);
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveEdit();
                }}
                className="max-h-60 min-h-16 w-full resize-none bg-transparent text-sm outline-none"
              />
              <div className="mt-1 flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveEdit}
                  className="rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background"
                >
                  Save &amp; submit
                </button>
              </div>
            </div>
          </MessageContent>
        </Message>
      );
    }

    return (
      <Message align={isUser ? "end" : "start"}>
        <MessageContent>
          {isUser ? (
            <div className="group flex flex-col items-end">
              {msg.attachments && msg.attachments.length > 0 && (
                <AttachmentChips attachments={msg.attachments} />
              )}
              <Bubble variant="secondary" align="end">
                <BubbleContent className="whitespace-pre-wrap dark:bg-white/[0.08] glass-panel rounded-xl">
                  {msg.content}
                </BubbleContent>
              </Bubble>
              {canAct && (
                <div className="mt-0.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    title="Edit & resubmit"
                    onClick={() => {
                      setDraft(msg.content);
                      setEditing(true);
                    }}
                    className="rounded-md p-1 text-muted-foreground hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
                  >
                    <Pencil className="size-3" />
                  </button>
                  <button
                    type="button"
                    title="Retry (resend this turn)"
                    onClick={() => void resendFrom(msg.id)}
                    className="rounded-md p-1 text-muted-foreground hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
                  >
                    <RotateCcw className="size-3" />
                  </button>
                </div>
              )}
              {/* Code: filesystem-aware rewind lives under the user message —
                  revert the workspace to before this turn and edit the prompt. */}
              {!home && !isStreaming && <RewindControl messageId={msg.id} />}
            </div>
          ) : (
            <div className="group">
              {mode === "thinking" && msg.reasoning ? (
                <ReasoningBlock text={msg.reasoning} streaming={!msg.content && !!isStreaming} />
              ) : null}
              <Bubble variant="ghost">
                <BubbleContent
                  className={cn(msg.isError && "text-destructive")}
                >
                  {msg.content ? (
                    <MarkdownViewer
                      content={msg.content}
                    />
                  ) : null}
                </BubbleContent>
              </Bubble>
            </div>
          )}
        </MessageContent>
      </Message>
    );
  },
  (prev, next) => prev.msg === next.msg && prev.mode === next.mode,
);

type GroupedItem =
  | ChatMessage
  | { type: "tool-group"; id: string; calls: ToolCall[] }
  | { type: "artifact-strip"; id: string; items: ArtifactItem[] };

/** Artifacts produced per TURN, keyed by the index of the turn's last
 * message — the strip renders right after that message, like the official
 * app's document card under the reply that created it. */
function stripIndexes(msgs: ChatMessage[]): Map<number, ArtifactItem[]> {
  const strips = new Map<number, ArtifactItem[]>();
  let acc = new Map<string, ArtifactItem>(); // dedupe by name, last wins
  let lastIdx = -1;
  const flush = (): void => {
    if (acc.size > 0 && lastIdx >= 0) strips.set(lastIdx, [...acc.values()]);
    acc = new Map();
    lastIdx = -1;
  };
  msgs.forEach((m, i) => {
    if (m.role === "user") {
      flush();
      return;
    }
    lastIdx = i;
    // Any tool whose result carries [artifact] markers contributes to the
    // turn's strip (RunPython, RunCommand, SandboxWrite, screenshots …).
    const out = m.toolCall?.output;
    if (out && out.includes("[artifact]"))
      for (const f of sandboxFilesFromOutput(out, m.timestamp))
        acc.set(f.name, f);
  });
  flush();
  return strips;
}

/** In Normal mode, consecutive tool messages become a single group card.
 * In every mode, a turn that produced sandbox files gets an artifact strip
 * right after its last message. */
function groupMessages(
  msgs: ChatMessage[],
  mode: TranscriptMode,
): GroupedItem[] {
  const strips = stripIndexes(msgs);
  const out: GroupedItem[] = [];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (mode === "normal" && m.role === "tool" && m.toolCall) {
      const group: ToolCall[] = [m.toolCall];
      let stripItems = strips.get(i);
      let j = i + 1;
      while (j < msgs.length && msgs[j].role === "tool" && msgs[j].toolCall) {
        group.push(msgs[j].toolCall!);
        stripItems = strips.get(j) ?? stripItems;
        j++;
      }
      out.push({ type: "tool-group", id: `tg-${i}`, calls: group });
      // The turn ended INSIDE this group (e.g. interrupted after a tool).
      if (stripItems)
        out.push({ type: "artifact-strip", id: `as-${i}`, items: stripItems });
      i = j;
    } else {
      out.push(m);
      const stripItems = strips.get(i);
      if (stripItems)
        out.push({ type: "artifact-strip", id: `as-${i}`, items: stripItems });
      i++;
    }
  }
  return out;
}

/** For each assistant turn (user→…→next-user), collect all assistant message
 * text and map it to the index of the turn's last item in `grouped`. */
function turnCopyTargets(grouped: GroupedItem[]): Map<number, string> {
  const out = new Map<number, string>();
  let parts: string[] = [];
  let lastIdx = -1;

  grouped.forEach((item, i) => {
    if ("type" in item) {
      // tool-group / artifact-strip — still part of the same turn
      lastIdx = i;
    } else if (item.role === "user") {
      if (parts.length > 0 && lastIdx >= 0) out.set(lastIdx, parts.join("\n\n"));
      parts = [];
      lastIdx = -1;
    } else if (item.content) {
      parts.push(item.content);
      lastIdx = i;
    }
  });

  if (parts.length > 0 && lastIdx >= 0) out.set(lastIdx, parts.join("\n\n"));
  return out;
}

function CopyMessageButton({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        );
      }}
      className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
      title="Copy response"
    >
      {copied ? (
        <>
          <Check className="size-3" /> Copied
        </>
      ) : (
        <>
          <Copy className="size-3" /> Copy
        </>
      )}
    </button>
  );
}

function CopyRow({ text }: { text: string }): JSX.Element {
  return (
    <MessageScrollerItem messageId={`copy-${text.slice(0, 32)}`}>
      <div className="flex justify-start pb-2">
        <CopyMessageButton text={text} />
      </div>
    </MessageScrollerItem>
  );
}

interface TurnSummary {
  id: string;
  /** The user request that opened the turn (null for a leading assistant turn). */
  request: string | null;
  /** Distinct tool names used in the turn, in first-use order. */
  toolNames: string[];
  /** Distinct files created/edited in the turn (from Edit/Write/MultiEdit). */
  filesChanged: string[];
  /** Number of tool calls in the turn. */
  stepCount: number;
  /** The assistant's final answer text for the turn. */
  answer: string;
  answerIsError: boolean;
}

/**
 * Summary mode: fold each user→assistant exchange into one card. We keep the
 * request and the final answer (the useful "output") and collapse every
 * intermediate tool call into a single "N steps · tools used" line.
 */
function summarizeTurns(msgs: ChatMessage[]): TurnSummary[] {
  const turns: TurnSummary[] = [];
  let cur: TurnSummary | null = null;
  const flush = (): void => {
    if (cur) turns.push(cur);
    cur = null;
  };
  msgs.forEach((m, i) => {
    if (m.role === "user") {
      flush();
      cur = {
        id: m.id || `turn-${i}`,
        request: m.content,
        toolNames: [],
        filesChanged: [],
        stepCount: 0,
        answer: "",
        answerIsError: false,
      };
      return;
    }
    if (!cur) {
      cur = {
        id: m.id || `turn-${i}`,
        request: null,
        toolNames: [],
        filesChanged: [],
        stepCount: 0,
        answer: "",
        answerIsError: false,
      };
    }
    if (m.role === "tool" && m.toolCall) {
      cur.stepCount++;
      const name = m.toolCall.name;
      if (name && !cur.toolNames.includes(name)) cur.toolNames.push(name);
      // Track files this turn wrote (Edit/Write/MultiEdit carry file_path).
      if (name === "Edit" || name === "Write" || name === "MultiEdit") {
        const fp = m.toolCall.input?.file_path;
        if (typeof fp === "string" && fp && !cur.filesChanged.includes(fp))
          cur.filesChanged.push(fp);
      }
    } else if (m.role === "assistant" && m.content?.trim()) {
      cur.answer = m.content;
      cur.answerIsError = !!m.isError;
    }
  });
  flush();
  return turns;
}

function SummaryTurnCard({ turn }: { turn: TurnSummary }): JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-card/40 px-4 py-3">
      {turn.request != null && (
        <div className="mb-2 flex gap-2">
          <span className="mt-0.5 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            You
          </span>
          <p className="line-clamp-3 whitespace-pre-wrap text-[13px] text-foreground">
            {turn.request}
          </p>
        </div>
      )}
      {turn.stepCount > 0 && (
        <div className="mb-2 text-[11px] text-muted-foreground">
          {turn.stepCount} {turn.stepCount === 1 ? "step" : "steps"}
          {turn.toolNames.length > 0 && <> · {turn.toolNames.join(", ")}</>}
        </div>
      )}
      {turn.filesChanged.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Files
          </span>
          {turn.filesChanged.map((f) => (
            <span
              key={f}
              title={f}
              className="max-w-[220px] truncate rounded bg-black/[0.04] px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground dark:bg-white/[0.06]"
            >
              {f.split(/[\\/]/).pop()}
            </span>
          ))}
        </div>
      )}
      {turn.answer ? (
        <div className={cn(turn.answerIsError && "text-destructive")}>
          <MarkdownViewer content={turn.answer} />
        </div>
      ) : (
        <div className="text-[13px] italic text-muted-foreground">
          No response yet.
        </div>
      )}
    </div>
  );
}

function pickGreeting(name: string, isFirstRun: boolean): {
  title: string;
  subtitle: string;
} {
  const now = new Date();
  const hour = now.getHours();
  let timeKey: keyof typeof greetings = "anytime";
  if (hour >= 5 && hour < 12) timeKey = "morning";
  else if (hour >= 12 && hour < 17) timeKey = "afternoon";
  else if (hour >= 17 && hour < 22) timeKey = "evening";
  else timeKey = "night";

  let title: string;
  if (isFirstRun) {
    const pool = greetings.first_run;
    title = pool[Math.floor(Math.random() * pool.length)];
  } else {
    const pool = [...greetings.anytime, ...(greetings[timeKey] || [])];
    title = pool[Math.floor(Math.random() * pool.length)];
  }
  title = title.replace("<name>", name);

  // Pick tamagotchi — date-specific categories first
  const tamagotchi = pickTamagotchi(now);

  return { title, subtitle: tamagotchi };
}

function pickTamagotchi(now: Date): string {
  const month = now.getMonth(); // 0-11
  const day = now.getDate();
  const dow = now.getDay(); // 0=Sun

  // Collect all applicable pools
  const pools: string[][] = [greetings.tamagotchi];

  // Holidays
  if ((month === 11 && day === 31) || (month === 0 && day <= 2))
    pools.push(greetings.tamagotchi_new_year as string[]);
  if (month === 11 && day >= 24 && day <= 26)
    pools.push(greetings.tamagotchi_christmas as string[]);
  if (month === 1 && day === 14)
    pools.push(greetings.tamagotchi_valentine as string[]);
  if (month === 2 && day === 8)
    pools.push(greetings.tamagotchi_womens_day as string[]);
  if (month === 3 && day === 1)
    pools.push(greetings.tamagotchi_april_fools as string[]);
  if (month === 3 && day === 15)
    pools.push(greetings.tamagotchi_art_day as string[]);
  if (month === 3 && day === 22)
    pools.push(greetings.tamagotchi_earth_day as string[]);
  if (month === 4 && day === 1)
    pools.push(greetings.tamagotchi_may_day as string[]);
  if (month === 4 && day === 18)
    pools.push(greetings.tamagotchi_museum_day as string[]);
  if (month === 6 && day === 14)
    pools.push(greetings.tamagotchi_bastille as string[]);
  if (month === 9 && day === 31)
    pools.push(greetings.tamagotchi_halloween as string[]);
  if (month === 10 && day === 14)
    pools.push(greetings.tamagotchi_monet_birthday as string[]);

  // Day of week
  if (dow === 1) pools.push(greetings.tamagotchi_monday as string[]);
  else if (dow === 5) pools.push(greetings.tamagotchi_friday as string[]);
  else if (dow === 0 || dow === 6) pools.push(greetings.tamagotchi_weekend as string[]);

  // Season
  if (month >= 2 && month <= 4) pools.push(greetings.tamagotchi_spring as string[]);
  else if (month >= 5 && month <= 7) pools.push(greetings.tamagotchi_summer as string[]);
  else if (month >= 8 && month <= 10) pools.push(greetings.tamagotchi_autumn as string[]);
  else pools.push(greetings.tamagotchi_winter as string[]);

  // Pick random pool, then random line from it
  const pool = pools[Math.floor(Math.random() * pools.length)];
  return pool[Math.floor(Math.random() * pool.length)];
}
export function ChatView({
  transcriptMode = "normal",
  sessionTitle,
  home = false,
  onOpenSettings,
  onOpenProvidersSettings,
}: {
  transcriptMode?: TranscriptMode;
  sessionTitle?: string;
  /** Home mode shows the "Ideas for you" chips; Code mode shows the stats
   * overview instead. */
  home?: boolean;
  onOpenSettings?: () => void;
  onOpenProvidersSettings?: () => void;
}): JSX.Element {
  const [podmanWarning, setPodmanWarning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [profileName, setProfileName] = useState("friend");
  // This chat's id — the Podman banner resolves its per-chat engine below.
  const sessionId = useChatStore((s) => s.currentSessionId);

  // Start the Podman VM straight from the banner — preparePodman() provisions
  // (if needed) and starts the Linux backend, which is all a wedged/idle
  // machine needs. Only the missing-WSL case actually requires Settings.
  const startPodman = async (): Promise<void> => {
    setStarting(true);
    setStartError(null);
    try {
      const r = await api()?.sandbox.preparePodman();
      if (r?.ok) setPodmanWarning(false);
      else
        setStartError(
          r?.needsWsl
            ? "WSL2 isn't installed — set it up in Settings → Sandbox."
            : r?.error ?? "Could not start the sandbox. See Settings → Sandbox.",
        );
    } catch {
      setStartError("Could not start the sandbox. See Settings → Sandbox.");
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    const a = api();
    if (!a) return;
    void a.profile.get().then((p) => {
      if (p.name) setProfileName(p.name);
    });
    return a.profile.onChanged((p) => {
      if (p.name) setProfileName(p.name);
    });
  }, []);

  useEffect(() => {
    if (!home) return;
    let cancelled = false;
    let timer: number | undefined;
    // Resolve THIS chat's engine (per-chat override, else global) — a chat pinned
    // to Podman warms even when the default is Pyodide, and vice versa.
    void api()
      ?.sandbox.getSessionConfig(sessionId ?? "default")
      .then(async (config) => {
        if (config.engine !== "docker" || cancelled) return;
        const result = await api()?.sandbox.isPodmanReady();
        if (cancelled) return;
        if (result?.ok) {
          setPodmanWarning(false);
          return;
        }
        // Not ready → warm the VM in the BACKGROUND now (so its cold boot is
        // hidden behind reading/typing) and poll until it comes up, clearing
        // the banner without any user action.
        setPodmanWarning(true);
        void api()?.sandbox.warmPodman(sessionId ?? "default");
        const started = Date.now();
        const poll = async (): Promise<void> => {
          if (cancelled) return;
          const r = await api()?.sandbox.isPodmanReady();
          if (cancelled) return;
          if (r?.ok) {
            setPodmanWarning(false);
            return;
          }
          if (Date.now() - started < 120_000)
            timer = window.setTimeout(() => void poll(), 2_500);
        };
        timer = window.setTimeout(() => void poll(), 2_500);
      })
      .catch(() => {
        if (!cancelled) setPodmanWarning(true);
      });
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [home, sessionId]);
  const messages = useChatStore((s) => s.messages);
  const error = useChatStore((s) => s.error);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const queue = useChatStore((s) => s.queue);
  const dequeueMessage = useChatStore((s) => s.dequeueMessage);
  const setComposerDraft = useChatStore((s) => s.setComposerDraft);
  const isEmpty = messages.length === 0 && !error;

  const isFirstRun = useMemo(() => {
    const flag = localStorage.getItem("monet-first-run");
    if (!flag) {
      localStorage.setItem("monet-first-run", "done");
      return true;
    }
    return false;
  }, []);

  const greeting = useMemo(() => pickGreeting(profileName, isFirstRun), [profileName, isFirstRun]);

  const grouped = groupMessages(messages, transcriptMode);
  const copyTargets = useMemo(() => turnCopyTargets(grouped), [grouped]);
  const summaryTurns =
    transcriptMode === "summary" ? summarizeTurns(messages) : null;

  const last = messages[messages.length - 1];
  const activeText =
    last?.role === "assistant" && last.isStreaming && !!last.content;
  const showWorking = isStreaming && !activeText;

  // Drag-and-drop anywhere over the chat stages the files as attachments.
  // Counter-based tracking: enter/leave fire for every child crossed.
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const isFileDrag = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.types).includes("Files");

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth.current++;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        if (isFileDrag(e)) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0)
          useChatStore.getState().setDroppedFiles(files);
      }}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-link bg-link/5">
          <span className="rounded-lg bg-card px-3 py-1.5 text-sm font-medium text-foreground shadow-sm">
            Drop files to attach
          </span>
        </div>
      )}
      {isEmpty && home ? (
        /* Home empty state: greeting + composer centered VERTICALLY, with the
           idea chips under the input. No working directory here — Home is a
           plain chat (markdown/formulas/tables), not an IDE. */
        <div className="flex flex-1 flex-col items-center justify-center overflow-auto px-4 py-8">
          <div className="w-full max-w-2xl text-center">
            <h2 className="font-[Copernicus] text-3xl font-medium text-foreground text-left">
              {greeting.title}
            </h2>
            <p className="w-full mt-2 text-base text-left leading-relaxed text-muted-foreground">
              {greeting.subtitle}
            </p>
          </div>
          <div className="mt-6 w-full max-w-2xl">
            <MessageInput flush onOpenProviders={onOpenProvidersSettings} />
          </div>
          {podmanWarning && (
            <div className="glass-panel glass-amber mt-1 mb-3 flex w-full max-w-2xl items-center justify-between gap-3 rounded-xl border border-amber-500/50 bg-amber-500/10 px-3 py-2.5 text-left text-[13px]">
              <span className="text-amber-900 dark:text-amber-200">
                The Home sandbox (Podman) isn&apos;t running.
                <br />
                {startError ??
                  "Start it to run Python — the first start can take a moment."}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void startPodman()}
                  disabled={starting}
                  className="flex items-center gap-1.5 rounded-md bg-amber-500/90 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {starting ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Play className="size-3" />
                  )}
                  {starting ? "Starting…" : "Start"}
                </button>
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="rounded-md border border-amber-600/40 px-2.5 py-1 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-500/10 dark:text-amber-200"
                >
                  Settings
                </button>
              </div>
            </div>
          )}
          <div className="w-full max-w-2xl mt-4.5">
            <div className="mb-2 text-left text-xs font-medium text-muted-foreground">
              Ideas for you
            </div>
            <div className="grid grid-cols-2 flex-col gap-1.5">
              {IDEAS.map((idea) => (
                <button
                  key={idea.label}
                  type="button"
                  onClick={() => setComposerDraft(idea.prompt)}
                  className="glass-panel glass-hover flex items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3 text-left text-sm transition-colors cursor-pointer"
                >
                  <idea.icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="font-medium">{idea.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : isEmpty ? (
        <div className="flex-1 overflow-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 pt-16 text-left">
            <h2 className="font-[Copernicus] w-full text-3xl font-medium text-foreground">
              {greeting.title}
            </h2>
            <p className="mt-2 w-full text-base leading-relaxed text-muted-foreground">
              {greeting.subtitle}
            </p>
          </div>
          <div className="mt-8">
            <StatsDashboard />
          </div>
        </div>
      ) : (
        <>
          {sessionTitle && (
            <div className="px-4 pt-3 text-[13px] font-medium text-muted-foreground">
              {sessionTitle}
            </div>
          )}
          <TodoCard messages={messages} />
          <MessageScrollerProvider autoScroll defaultScrollPosition="end">
            <MessageScroller className="flex-1">
              <MessageScrollerViewport>
                <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-2 px-4 py-4">
                  {summaryTurns
                    ? summaryTurns.map((t, i) => (
                        <MessageScrollerItem
                          key={t.id}
                          messageId={t.id}
                          scrollAnchor={
                            !showWorking && i === summaryTurns.length - 1
                          }
                        >
                          <SummaryTurnCard turn={t} />
                        </MessageScrollerItem>
                      ))
                    : grouped.flatMap((item, i) => {
                    const copyBtn = copyTargets.get(i);
                    if ("type" in item && item.type === "tool-group") {
                      const el = (
                        <MessageScrollerItem
                          key={item.id}
                          messageId={item.id}
                          scrollAnchor={
                            !showWorking && i === grouped.length - 1
                          }
                        >
                          <ToolCallBubble
                            toolCall={item.calls[0]}
                            groupMembers={item.calls.slice(1)}
                            mode={transcriptMode}
                          />
                        </MessageScrollerItem>
                      );
                      if (!copyBtn) return [el];
                      return [el, <CopyRow key={`copy-${i}`} text={copyBtn} />];
                    }
                    if ("type" in item && item.type === "artifact-strip") {
                      const el = (
                        <MessageScrollerItem
                          key={item.id}
                          messageId={item.id}
                          scrollAnchor={
                            !showWorking && i === grouped.length - 1
                          }
                        >
                          <ArtifactsStrip items={item.items} />
                        </MessageScrollerItem>
                      );
                      if (!copyBtn) return [el];
                      return [el, <CopyRow key={`copy-${i}`} text={copyBtn} />];
                    }
                    const el = (
                      <MessageScrollerItem
                        key={item.id}
                        messageId={item.id}
                        scrollAnchor={!showWorking && i === grouped.length - 1}
                      >
                        <MessageRow
                          msg={item as ChatMessage}
                          mode={transcriptMode}
                        />
                      </MessageScrollerItem>
                    );
                    if (!copyBtn) return [el];
                    return [el, <CopyRow key={`copy-${i}`} text={copyBtn} />];
                  })}

                  {showWorking && (
                    <MessageScrollerItem messageId="__working" scrollAnchor>
                      <WorkingRow />
                    </MessageScrollerItem>
                  )}

                  {queue.map((msg) => (
                    <MessageScrollerItem
                      key={`q-${msg.id}`}
                      messageId={`q-${msg.id}`}
                    >
                      <Message align="end">
                        <MessageContent>
                          <div className="group flex items-start justify-end gap-1">
                            <button
                              type="button"
                              title="Remove from queue"
                              onClick={() => {
                                const sid = useChatStore.getState().currentSessionId;
                                if (sid) dequeueMessage(sid, msg.id);
                              }}
                              className="mt-5 shrink-0 rounded-md p-1 text-muted-foreground transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                            >
                              <XIcon className="size-5" />
                            </button>
                            <div className="flex flex-col items-end">
                              <div className="mb-0.5 flex items-center gap-1 text-[11px] text-muted-foreground/70">
                                <Clock className="size-3" />
                                Queued
                              </div>
                              <Bubble variant="secondary" align="end">
                                <BubbleContent className="whitespace-pre-wrap dark:bg-white/[0.06] glass-panel rounded-xl border border-dashed border-border opacity-70">
                                  {msg.content}
                                </BubbleContent>
                              </Bubble>
                            </div>
                          </div>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ))}

                  {error && (
                    <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                      {error}
                    </div>
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton direction="end" />
            </MessageScroller>
          </MessageScrollerProvider>
        </>
      )}

      {/* Structured question panel — sits just above the composer, over the
          chat (scrollable), collapsible. Renders null when nothing is asked. */}
      <AskUserHost />

      {/* Bottom composer — except in the Home empty state, where the composer
          is centered above. Home never shows the working-directory picker. */}
      {!(isEmpty && home) && (
        <>
          {!home && (
            <div className="mx-auto w-full max-w-3xl px-4 pb-1">
              <WorkspacePicker />
            </div>
          )}
          {!home && <GitCard />}
          <MessageInput onOpenProviders={onOpenProvidersSettings} />
        </>
      )}
    </div>
  );
}

export function PermissionHost(): JSX.Element | null {
  const [request, setRequest] = useState<PermissionRequest | null>(null);

  useEffect(() => {
    const bridge = (window as unknown as { electronAPI?: ElectronAPI })
      .electronAPI;
    if (!bridge?.permissions) return;
    return bridge.permissions.onRequest((req: PermissionRequest) =>
      setRequest(req),
    );
  }, []);

  if (!request) return null;

  return (
    <PermissionDialog
      key={request.id}
      request={request}
      onDecision={(decision) => {
        const bridge = (window as unknown as { electronAPI?: ElectronAPI })
          .electronAPI;
        bridge?.permissions.respond(decision);
        setRequest(null);
      }}
    />
  );
}

export function AskUserHost(): JSX.Element | null {
  const [request, setRequest] = useState<AskUserRequest | null>(null);

  useEffect(() => {
    const bridge = (window as unknown as { electronAPI?: ElectronAPI })
      .electronAPI;
    if (!bridge?.askUser) return;
    return bridge.askUser.onRequest((req: AskUserRequest) => setRequest(req));
  }, []);

  if (!request) return null;

  const bridge = (window as unknown as { electronAPI?: ElectronAPI })
    .electronAPI;
  return (
    <AskUserDialog
      key={request.id}
      request={request}
      onSubmit={(answers) => {
        bridge?.askUser.respond(request.id, false, answers);
        setRequest(null);
      }}
      onCancel={() => {
        bridge?.askUser.respond(request.id, true);
        setRequest(null);
      }}
    />
  );
}
