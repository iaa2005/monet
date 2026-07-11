import { useEffect, useState, useMemo, useRef, memo } from "react";
import { useChatStore } from "@/stores/chatStore";
import { MarkdownViewer } from "./MarkdownViewer";
import { ToolCallBubble } from "./ToolCallBubble";
import { MessageInput } from "./MessageInput";
import { TodoCard } from "./TodoCard";
import { GitCard } from "./GitCard";
import { PermissionDialog } from "./PermissionDialog";
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
  FileSearch,
  FlaskConical,
  GitPullRequest,
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
import type { ElectronAPI, PermissionRequest } from "@/types/electron";
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

/** Memoized so a streaming flush only re-renders the message that changed —
 * finished messages keep their object identity in the store, so re-parsing
 * their markdown (the main scroll-lag source) is skipped entirely. */
const MessageRow = memo(
  function MessageRow({
    msg,
    mode,
  }: {
    msg: ChatMessage;
    mode?: TranscriptMode;
  }): JSX.Element {
    if (msg.role === "tool" && msg.toolCall) {
      return <ToolCallBubble toolCall={msg.toolCall} mode={mode} />;
    }

    const isUser = msg.role === "user";

    return (
      <Message align={isUser ? "end" : "start"}>
        <MessageContent>
          {isUser ? (
            <>
              {msg.attachments && msg.attachments.length > 0 && (
                <AttachmentChips attachments={msg.attachments} />
              )}
              <Bubble variant="secondary" align="end">
                <BubbleContent className="whitespace-pre-wrap dark:bg-white/[0.08]">
                  {msg.content}
                </BubbleContent>
              </Bubble>
            </>
          ) : (
            <Bubble variant="ghost">
              <BubbleContent className={cn(msg.isError && "text-destructive")}>
                {msg.content ? <MarkdownViewer content={msg.content} /> : null}
              </BubbleContent>
            </Bubble>
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
    // Any tool whose result carries [sandbox-file] markers contributes to the
    // turn's strip (RunPython, RunCommand, SandboxWrite, screenshots …).
    const out = m.toolCall?.output;
    if (out && out.includes("[sandbox-file]"))
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

interface TurnSummary {
  id: string;
  /** The user request that opened the turn (null for a leading assistant turn). */
  request: string | null;
  /** Distinct tool names used in the turn, in first-use order. */
  toolNames: string[];
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
        stepCount: 0,
        answer: "",
        answerIsError: false,
      };
    }
    if (m.role === "tool" && m.toolCall) {
      cur.stepCount++;
      const name = m.toolCall.name;
      if (name && !cur.toolNames.includes(name)) cur.toolNames.push(name);
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

function pickGreeting(isFirstRun: boolean): {
  title: string;
  subtitle: string;
} {
  const hour = new Date().getHours();
  let timeKey: keyof typeof greetings = "anytime";
  if (hour >= 5 && hour < 12) timeKey = "morning";
  else if (hour >= 12 && hour < 17) timeKey = "afternoon";
  else if (hour >= 17 && hour < 22) timeKey = "evening";
  else timeKey = "night";

  const name = localStorage.getItem("user-name") || "friend";

  let title: string;
  if (isFirstRun) {
    const pool = greetings.first_run;
    title = pool[Math.floor(Math.random() * pool.length)];
  } else {
    const pool = [...greetings.anytime, ...(greetings[timeKey] || [])];
    title = pool[Math.floor(Math.random() * pool.length)];
  }
  title = title.replace("<name>", name);

  const tamagotchi =
    greetings.tamagotchi[
      Math.floor(Math.random() * greetings.tamagotchi.length)
    ];

  return { title, subtitle: tamagotchi };
}
export function ChatView({
  transcriptMode = "normal",
  sessionTitle,
  home = false,
  onOpenSettings,
}: {
  transcriptMode?: TranscriptMode;
  sessionTitle?: string;
  /** Home mode shows the "Ideas for you" chips; Code mode shows the stats
   * overview instead. */
  home?: boolean;
  onOpenSettings?: () => void;
}): JSX.Element {
  const [podmanWarning, setPodmanWarning] = useState(false);

  useEffect(() => {
    if (!home) return;
    void api()
      ?.sandbox.getConfig()
      .then(async (config) => {
        if (config.engine !== "docker") return;
        // Non-destructive probe — must NOT init/start/restart the machine just
        // because the user opened a Home chat (that wedged the VM previously).
        const result = await api()?.sandbox.isPodmanReady();
        setPodmanWarning(!result?.ok);
      })
      .catch(() => setPodmanWarning(true));
  }, [home]);
  const messages = useChatStore((s) => s.messages);
  const error = useChatStore((s) => s.error);
  const isStreaming = useChatStore((s) => s.isStreaming);
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

  const greeting = useMemo(() => pickGreeting(isFirstRun), [isFirstRun]);

  const grouped = groupMessages(messages, transcriptMode);
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
            <MessageInput flush />
          </div>
          {podmanWarning && (
            <div className="-mt-2 mb-3 flex w-full max-w-2xl items-center justify-between gap-3 rounded-b-xl border border-amber-500/50 bg-amber-500/10 px-3 pb-2.5 pt-4.5 text-left text-[13px]">
              <span className="text-amber-900 dark:text-amber-200">
                Podman is not ready.
                <br />
                Run Python will not work until you install it in Settings → Sandbox.
              </span>
              <button
                type="button"
                onClick={onOpenSettings}
                className="shrink-0 rounded-md border border-amber-600/40 px-2.5 py-1 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-500/10 dark:text-amber-200"
              >
                Open settings
              </button>
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
                  className="flex items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3 text-left text-sm transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
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
                    : grouped.map((item, i) => {
                    if ("type" in item && item.type === "tool-group") {
                      return (
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
                    }
                    if ("type" in item && item.type === "artifact-strip") {
                      return (
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
                    }
                    return (
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
                  })}

                  {showWorking && (
                    <MessageScrollerItem messageId="__working" scrollAnchor>
                      <WorkingRow />
                    </MessageScrollerItem>
                  )}

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
          <MessageInput />
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
