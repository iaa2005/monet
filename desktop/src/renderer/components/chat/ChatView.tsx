import { useCallback, useEffect, useState, useMemo, useRef, memo } from "react";
import { useChatStore, INTERRUPT_MARK } from "@/stores/chatStore";
import { MarkdownViewer } from "./MarkdownViewer";
import { ToolCallBubble } from "./ToolCallBubble";
import { MessageInput } from "./MessageInput";
import { TodoCard } from "./TodoCard";
import { GitCard } from "./GitCard";
import { PermissionDialog } from "./PermissionDialog";
import { PlanFallbackBar } from "./PlanFallbackBar";
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
import { WorkingIndicator } from "./WorkingIndicator";
import { StatsDashboard } from "@/components/StatsDashboard";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import {
  Bug,
  Check,
  Copy,
  FileSearch,
  FlaskConical,
  GitFork,
  GitPullRequest,
  History,
  Loader2,
  Eye,
  EyeOff,
  Pencil,
  Play,
  RotateCcw,
  Clock,
  CornerDownLeft,
  Brain,
  X as XIcon,
  type LucideIcon,
} from "lucide-react";
import { ArtifactsStrip } from "@/components/ArtifactsPanel";
import { stripIndexes } from "./artifact-strips";
import { viewArtifact } from "@/components/artifact-actions";
import { FilePreviewTile } from "@/components/FileCard";
import {
  extOf,
  useArtifactImage,
  usePdfThumb,
} from "@/components/artifact-media";
import { isPdf } from "@/lib/pdfThumb";
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
import { SelectionText } from "./SelectionText";
import { joinSelections, splitSelections, usedRefs } from "@/lib/selection-marks";
import {
  copyTargets as computeCopyTargets,
  rendersAsCard,
  shouldShowWorking,
} from "./turn-state";

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

function WorkingRow({
  messages,
  startedAt,
}: {
  messages: ChatMessage[];
  startedAt: number;
}): JSX.Element {
  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="ghost">
          <BubbleContent>
            <WorkingIndicator messages={messages} startedAt={startedAt} />
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

type SentAttachment = NonNullable<ChatMessage["attachments"]>[number];

/** One attachment of a sent message. Its own component because the image URL
 * is resolved with a hook, which cannot run inside a map callback. */
function AttachmentTile({ a }: { a: SentAttachment }): JSX.Element {
  const thumb = useArtifactImage(a);
  const isImage = a.kind === "image" && Boolean(a.dataUrl || a.path);
  const pdf = usePdfThumb(
    isPdf(a.name, a.mediaType) && a.path ? a.path : null,
    async () => {
      const r = await window.electronAPI?.artifacts.readBytes(a.path!);
      if (!r?.ok || !r.base64) return null;
      const bin = atob(r.base64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    },
  );
  return (
    <FilePreviewTile
      name={a.name}
      badge={extOf(a.name).toUpperCase() || "FILE"}
      thumbUrl={(isImage ? thumb : pdf) ?? undefined}
      onClick={a.path || a.dataUrl ? () => viewArtifact(a) : undefined}
    />
  );
}

/** The files a user message carried, above the bubble. Same tile as the
 * composer and the Content panel, so attaching, sending and revisiting a file
 * all look like the same object. */
function AttachmentChips({
  attachments,
}: {
  attachments: NonNullable<ChatMessage["attachments"]>;
}): JSX.Element {
  return (
    <div className="mb-1.5 grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
      {attachments.map((a, i) => (
        <AttachmentTile key={`${i}-${a.name}`} a={a} />
      ))}
    </div>
  );
}

/** Code "Rewind to here", shown under a USER message: reverts the workspace to
 * the state BEFORE this turn and drops the prompt back into the composer to edit
 * and resend. Previews how much the revert would undo (files, +ins/-del) on
 * hover. */
function RewindControl({
  messageId,
  bare = false,
}: {
  messageId: string;
  /** Rendered inside a shared action row that owns hover visibility. */
  bare?: boolean;
}): JSX.Element {
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
      className={
        bare
          ? "flex"
          : "mt-0.5 flex opacity-0 transition-opacity group-hover:opacity-100"
      }
      onMouseEnter={loadStat}
    >
      <button
        type="button"
        title={
          !sha
            ? "Rewind to here — rewinds the conversation only (no file checkpoint exists for this turn)"
            : hasChanges
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
          {sha ? (
            <>
              This will restore the workspace to before this turn and put the
              prompt back in the composer for editing and resubmission.
              {hasChanges && (
                <> This will undo {stat!.files} changed {stat!.files === 1 ? "file" : "files"} (+{stat!.insertions}/-{stat!.deletions}).</>
              )}
            </>
          ) : (
            <>
              Only the conversation will rewind — no file checkpoint exists for
              this turn (it is the first turn, or checkpoints could not be
              taken), so your files stay exactly as they are.
            </>
          )}
        </p>
        {sha && (
          <p className="mt-2 text-xs text-muted-foreground">
            The project folder is shared by every chat and branch of this
            project. Reverting files also undoes changes made from other chats
            after this point — their conversations keep describing files that no
            longer look that way.
          </p>
        )}
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

/**
 * Past this many characters a user message is a PASTED DOCUMENT, not a
 * sentence — it clamps to a readable height with a "Show more".
 *
 * Chosen against the case that prompted it: a field report of tag results,
 * ~1.5 KB, which pushed the whole conversation off screen every time you
 * scrolled past it. A long paragraph (a few hundred characters) stays whole;
 * anything that would occupy most of the viewport does not.
 */
const LONG_USER_MESSAGE = 900;

const MessageRow = memo(
  function MessageRow({
    msg,
    mode,
    droppedFromContext,
    onToggleContext,
  }: {
    msg: ChatMessage;
    mode?: TranscriptMode;
    /** This prompt is not being sent to the model. */
    droppedFromContext?: boolean;
    /** Toggle that. Absent while a run is in flight. */
    onToggleContext?: (messageId: string) => void | Promise<void>;
  }): JSX.Element {
    const isStreaming = useChatStore((s) => s.isStreaming);
    const home = useChatStore((s) => s.space === "home");
    const resendFrom = useChatStore((s) => s.resendFrom);
    const [editing, setEditing] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [draft, setDraft] = useState(() => splitSelections(msg.content).text);

    if (msg.role === "tool" && msg.toolCall) {
      return <ToolCallBubble toolCall={msg.toolCall} mode={mode} />;
    }

    // A harness intervention: the scaffolding redirected the model (a nudge,
    // a loop correction, a budget note). One slim line — enough to explain a
    // turn the model did not choose, without pretending anybody spoke.
    if (msg.role === "system") {
      return (
        <div className="my-1 flex items-center gap-2 px-1">
          <div className="h-px flex-1 bg-border" />
          <span className="max-w-[80%] text-center text-[10px] text-muted-foreground">
            {msg.content}
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>
      );
    }

    const isUser = msg.role === "user";
    // Edit/Retry rewind the conversation, so only offer them in Home (Code gets
    // filesystem-aware Rewind) and never mid-stream.
    const canAct = isUser && home && !isStreaming;
    // A pasted document collapses; a paragraph does not. The threshold is in
    // CHARACTERS, not rendered height, so the decision is stable before
    // layout and identical on every re-render.
    const longMessage = isUser && msg.content.length > LONG_USER_MESSAGE;

    const saveEdit = (): void => {
      const t = draft.trim();
      setEditing(false);
      // The element context rides along again — unless the user deleted the
      // ⟨token⟩ that referred to it, which is how you drop one.
      const kept = usedRefs(t, editable.refs, (r) => r.label);
      const full = joinSelections(t, kept);
      if (t && full !== msg.content) void resendFrom(msg.id, full);
    };

    // Editing shows the sentence, not the machine-collected description of the
    // element — but the description has to survive the edit, so it is put back
    // on save. Stripping it for real would silently drop the context.
    const editable = splitSelections(msg.content);
    const ownAttachments = (msg.attachments ?? []).filter(
      (a) => a.origin !== "selection",
    );
    const cropAttachments = (msg.attachments ?? []).filter(
      (a) => a.origin === "selection",
    );

    if (isUser && editing) {
      return (
        <Message align="end">
          <MessageContent>
            <div className="w-full min-w-[18rem] rounded-lg border border-border bg-card p-4">
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
              {/* Element crops are left out: they belong to the ⟨chip⟩ that
                  stands for the element, not to the row of files the user
                  attached. The browser tool made them, nobody picked them. */}
              {ownAttachments.length > 0 && (
                <AttachmentChips attachments={ownAttachments} />
              )}
              <Bubble variant="secondary" align="end">
                <BubbleContent className="whitespace-pre-wrap dark:bg-white/[0.08] glass-panel">
                  {/* A pasted wall of text is context, not something to
                      re-read on every scroll past it: past a threshold the
                      bubble clamps to a readable height, fades out and offers
                      the rest. Nothing is lost — the model still gets all of
                      it, and one click brings it back on screen. */}
                  <div
                    className={cn(
                      "relative",
                      longMessage &&
                        !expanded &&
                        "max-h-[19rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_74%,transparent)]",
                    )}
                  >
                    <SelectionText content={msg.content} crops={cropAttachments} />
                  </div>
                  {longMessage && (
                    <button
                      type="button"
                      onClick={() => setExpanded((v) => !v)}
                      className="mt-1 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {expanded ? "Show less" : "Show more"}
                    </button>
                  )}
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
                  {/* Take this ONE prompt out of what the model reads — its
                      reply and tool calls go with it. Nothing is deleted:
                      the turn stays on screen, fainter, and the button puts
                      it back. */}
                  {onToggleContext && (
                    <button
                      type="button"
                      title={
                        droppedFromContext
                          ? "Put this prompt back into the model's context"
                          : "Remove this prompt (and its reply) from the model's context — nothing is deleted, and files are untouched"
                      }
                      onClick={() => void onToggleContext(msg.id)}
                      className="rounded-md p-1 text-muted-foreground hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
                    >
                      {droppedFromContext ? (
                        <Eye className="size-3" />
                      ) : (
                        <EyeOff className="size-3" />
                      )}
                    </button>
                  )}
                </div>
              )}
              {/* Code: filesystem-aware rewind lives under the user message —
                  revert the workspace to before this turn and edit the prompt.
                  Branch is its non-destructive sibling: same cut point, but as
                  a NEW chat, with this history and the original untouched. */}
              {!home && !isStreaming && (
                <div className="mt-0.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <RewindControl messageId={msg.id} bare />
                  <button
                    type="button"
                    title="Branch from here — a new chat with the history up to this point; this one keeps everything"
                    onClick={() => useChatStore.getState().requestFork(msg.id)}
                    className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
                  >
                    <GitFork className="size-3" />
                    Branch
                  </button>
                </div>
              )}
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
                      content={stripInterrupt(msg.content)}
                    />
                  ) : null}
                  {isInterrupted(msg.content) && (
                    <span className="mt-2 inline-flex items-center rounded-md bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
                      Stopped
                    </span>
                  )}
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

/**
 * What a message the model no longer reads looks like: present, plainly
 * not the model's any more, and nothing else.
 *
 * It used to carry a brand-coloured edge as well, to pair with a divider
 * drawn across the chat. Both are gone: a rule saying "everything above
 * here is out" stops being true the moment a prompt in the MIDDLE is
 * dropped, which is now an ordinary thing to do. Faint is enough, and it
 * is the only thing that reads correctly whichever turns are out.
 */
const OUT_OF_CONTEXT_CLASS = "opacity-45 saturate-50";

/** In Normal mode, consecutive tool messages become a single group card.
 * In every mode, a turn that produced sandbox files gets an artifact strip
 * right after its last message. */
/** Windowing: how much of the tail mounts initially, and per reveal step. */
const WINDOW_INITIAL = 80;
const WINDOW_STEP = 120;

/** The top-of-transcript sentinel: scrolling it into view mounts an earlier
 * slice. A button too, for keyboard/page-up users. */
function RevealEarlier({
  hiddenCount,
  onReveal,
}: {
  hiddenCount: number;
  onReveal: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          // One slice per sighting: reveal, stop watching, and let the
          // re-render (hiddenCount changed) arm a fresh observer. Without
          // this the callback kept firing while layout settled and a single
          // scroll-to-top could mount the entire chat in one frame.
          obs.disconnect();
          onReveal();
        }
      },
      { rootMargin: "400px 0px 0px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [onReveal, hiddenCount]);
  return (
    <div ref={ref} className="flex justify-center py-2">
      <button
        type="button"
        onClick={onReveal}
        className="rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
      >
        Show earlier messages ({hiddenCount})
      </button>
    </div>
  );
}

function groupMessages(
  msgs: ChatMessage[],
  mode: TranscriptMode,
  streaming = false,
): GroupedItem[] {
  const strips = stripIndexes(msgs, streaming);
  const out: GroupedItem[] = [];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    // A plan is a CARD, not a tool row: it carries the Build buttons, so it
    // must never be folded into a group (the group renders its members
    // itself, and the card would never get drawn — which left the approval
    // waiting for its ten-minute timeout with nothing on screen to answer).
    const isCard = (c: ToolCall | undefined): boolean =>
      rendersAsCard(c?.name);
    if (mode === "normal" && m.role === "tool" && m.toolCall && !isCard(m.toolCall)) {
      const group: ToolCall[] = [m.toolCall];
      let stripItems = strips.get(i);
      let j = i + 1;
      while (
        j < msgs.length &&
        msgs[j].role === "tool" &&
        msgs[j].toolCall &&
        !isCard(msgs[j].toolCall)
      ) {
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
/**
 * True while the assistant's visible text is actually growing.
 *
 * Goes false after `idleMs` of no growth, which is what tells the chat that
 * the model has moved on to a tool (or is composing a long tool input) and
 * the "Working" row belongs back on screen.
 */
function useTextFlowing(text: string, streaming: boolean, idleMs = 1200): boolean {
  const [flowing, setFlowing] = useState(false);
  const lastLen = useRef(-1);
  useEffect(() => {
    if (!streaming || !text) {
      lastLen.current = -1;
      setFlowing(false);
      return;
    }
    if (text.length !== lastLen.current) {
      lastLen.current = text.length;
      setFlowing(true);
    }
    const t = setTimeout(() => setFlowing(false), idleMs);
    return () => clearTimeout(t);
  }, [text, streaming, idleMs]);
  return flowing;
}

function isInterrupted(content: string | undefined): boolean {
  return !!(content && content.includes(INTERRUPT_MARK));
}

function stripInterrupt(content: string): string {
  return content.endsWith(INTERRUPT_MARK)
    ? content.slice(0, -INTERRUPT_MARK.length)
    : content;
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

/**
 * The copy affordance under a finished turn.
 *
 * Hidden until the pointer is over the turn it belongs to (the message above
 * carries `peer/turn`) or over the row itself — a button that is always there
 * reads as part of the transcript, which it is not.
 */
function CopyRow({ text }: { text: string }): JSX.Element {
  return (
    <MessageScrollerItem
      messageId={`copy-${text.slice(0, 32)}`}
      className="opacity-0 transition-opacity focus-within:opacity-100 hover:opacity-100 peer-hover/turn:opacity-100"
    >
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
  const pendingInjections = useChatStore((s) => s.pendingInjections);
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

  const grouped = useMemo(
    () => groupMessages(messages, transcriptMode, isStreaming),
    [messages, transcriptMode, isStreaming],
  );

  // A counter that changes whenever something moved the context WITHOUT
  // adding a message — an undone prompt, a prompt taken out by hand — so
  // the list below is re-read. The context EVENTS are still logged, but
  // nothing derives the truth from them any more.
  const contextVersion = useChatStore((s) => s.contextVersion);
  const ctxVersion = messages.length + contextVersion * 100000;

  /**
   * Which prompts the model can still read — asked, not derived.
   *
   * This used to be arithmetic: replay every compaction and undo, track a
   * head offset, convert context-relative turn counts into absolute ones,
   * and hope the boundary landed on the right message. The transcript now
   * carries the answer per message, so the chat asks for it.
   */
  const [outOfContext, setOutOfContext] = useState<Set<string>>(new Set());
  const refreshContext = useCallback(async () => {
    if (!sessionId) return;
    const turns = await api()?.chat.turnContext(sessionId);
    setOutOfContext(
      new Set((turns ?? []).filter((t) => !t.inContext).map((t) => t.id)),
    );
  }, [sessionId]);
  useEffect(() => {
    void refreshContext();
  }, [refreshContext, ctxVersion, isStreaming]);

  const toggleTurnContext = useCallback(
    async (messageId: string) => {
      if (!sessionId) return;
      const dropped = outOfContext.has(messageId);
      const r = await api()?.chat.setTurnContext(sessionId, messageId, dropped);
      // A prompt with no transcript turn behind it cannot be taken out of a
      // context it was never in — and until now this returned silently, which
      // is indistinguishable from a broken button. It WAS broken, for every
      // chat: the transcript store had been dead since a schema mistake, so
      // there was never a turn to point at. Saying so costs one line and turns
      // "nothing happens" into something a person can act on.
      if (r && !r.ok) {
        useChatStore
          .getState()
          .setError(
            "This prompt has no model-facing turn behind it, so it cannot be " +
              "taken out of context. Prompts sent from now on can be.",
          );
        return;
      }
      await refreshContext();
    },
    [sessionId, outOfContext, refreshContext],
  );

  /**
   * A turn is dropped by its PROMPT, so every message after a dropped
   * prompt is dropped too until the next prompt. Walked once here rather
   * than asked per message.
   */
  const droppedRows = useMemo(() => {
    const out = new Set<number>();
    let dropping = false;
    messages.forEach((m, i) => {
      if (m.role === "user") dropping = outOfContext.has(m.id);
      if (dropping) out.add(i);
    });
    return out;
  }, [messages, outOfContext]);

  /** Message index behind a grouped item — tool groups and artifact strips
   * carry it in their id (see groupMessages). */
  const indexOfItem = useMemo(() => {
    const byId = new Map<string, number>();
    messages.forEach((m, i) => byId.set(m.id, i));
    return (item: GroupedItem): number => {
      if ("type" in item) {
        const n = Number(item.id.slice(item.id.indexOf("-") + 1));
        return Number.isFinite(n) ? n : -1;
      }
      return byId.get(item.id) ?? -1;
    };
  }, [messages]);

  // ── Windowing ──────────────────────────────────────────────────────
  // A long chat renders only its tail: the last `reveal` grouped items plus
  // whatever the user has scrolled back into. Scrolling to the top mounts
  // another slice (the sentinel below observes itself into view). Together
  // with the items' content-visibility this bounds both React work per
  // streaming flush and the DOM the compositor has to carry.
  const [reveal, setReveal] = useState(WINDOW_INITIAL);
  useEffect(() => setReveal(WINDOW_INITIAL), [sessionId]);
  const windowStart = Math.max(0, grouped.length - reveal);
  // The rules live in turn-state.ts so they can be asserted without a browser
  // (scripts/working-copy-probe.ts). Here we only adapt the shapes.
  const copyTargets = useMemo(
    () =>
      computeCopyTargets(
        grouped.map((item) =>
          "type" in item
            ? ({ kind: "other" } as const)
            : ({
                kind: "message",
                role: item.role as "user" | "assistant" | "tool",
                content: item.content ? stripInterrupt(item.content) : undefined,
              } as const),
        ),
        isStreaming,
      ),
    [grouped, isStreaming],
  );
  const summaryTurns =
    transcriptMode === "summary" ? summarizeTurns(messages) : null;

  const last = messages[messages.length - 1];
  // Is TEXT arriving right now? Not "is the message flagged streaming" — that
  // flag stays set for the whole turn, and a model writing a large file spends
  // minutes streaming the tool INPUT with no visible text at all. The old rule
  // read that as "text is flowing", so the working chip vanished and the turn
  // looked finished while the stop button was still red (reported from use).
  // Growth of the visible content is the honest signal.
  const streamingText =
    last?.role === "assistant" && last.isStreaming ? (last.content ?? "") : "";
  const textFlowing = useTextFlowing(streamingText, isStreaming);
  const showWorking = shouldShowWorking({ streaming: isStreaming, textFlowing });

  // When the current run began, for the elapsed clock on the working row.
  //
  // It lives HERE rather than in WorkingIndicator because that component
  // unmounts every time the model emits a chunk of text and remounts when it
  // goes back to tools — a clock owned by it would restart at 0s repeatedly on
  // exactly the long turns the number is meant to describe.
  //
  // Keyed by session, and only stamped the first time a session is seen
  // streaming: chats run independently, so leaving a long turn to read another
  // chat and coming back must not restart its clock at zero. The entry is
  // dropped when the run ends, so the next turn gets a fresh stamp.
  const [turnStarts, setTurnStarts] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!sessionId) return;
    setTurnStarts((prev) => {
      if (isStreaming)
        return prev[sessionId] ? prev : { ...prev, [sessionId]: Date.now() };
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, [isStreaming, sessionId]);
  const turnStartedAt = (sessionId && turnStarts[sessionId]) || Date.now();

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
        <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-lg border-2 border-dashed border-link bg-link/5">
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
            <h2 className="font-display text-3xl font-medium text-foreground text-left">
              {greeting.title}
            </h2>
            <p className="w-full mt-2 text-base text-left leading-relaxed text-muted-foreground">
              {greeting.subtitle}
            </p>
          </div>
          <div className="mt-6 w-full max-w-2xl">
            <PlanFallbackBar />
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
            <h2 className="font-display w-full text-3xl font-medium text-foreground">
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
                  {!summaryTurns && windowStart > 0 && (
                    <RevealEarlier
                      hiddenCount={windowStart}
                      onReveal={() => setReveal((r) => r + WINDOW_STEP)}
                    />
                  )}
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
                    : grouped.slice(windowStart).flatMap((item, j) => {
                    const i = windowStart + j;
                    const copyBtn = copyTargets.get(i);
                    // Where this item sits relative to what the model can
                    // still read — see lib/context-map.ts.
                    const msgIdx = indexOfItem(item);
                    const outOfCtx = msgIdx >= 0 && droppedRows.has(msgIdx);
                    // No dividers any more: a dropped turn is simply
                    // fainter. A rule across the chat said "everything
                    // above here is gone", which stops being true the
                    // moment a prompt in the MIDDLE is dropped.
                    const withBreak = (nodes: JSX.Element[]): JSX.Element[] => nodes;
                    if ("type" in item && item.type === "tool-group") {
                      const el = (
                        <MessageScrollerItem
                          key={item.id}
                          messageId={item.id}
                          scrollAnchor={
                            !showWorking && i === grouped.length - 1
                          }
                          className={cn(copyBtn && "peer/turn", outOfCtx && OUT_OF_CONTEXT_CLASS)}
                        >
                          <ToolCallBubble
                            toolCall={item.calls[0]}
                            groupMembers={item.calls.slice(1)}
                            mode={transcriptMode}
                          />
                        </MessageScrollerItem>
                      );
                      if (!copyBtn) return withBreak([el]);
                      return withBreak([el, <CopyRow key={`copy-${i}`} text={copyBtn} />]);
                    }
                    if ("type" in item && item.type === "artifact-strip") {
                      const el = (
                        <MessageScrollerItem
                          key={item.id}
                          messageId={item.id}
                          scrollAnchor={
                            !showWorking && i === grouped.length - 1
                          }
                          className={cn(copyBtn && "peer/turn", outOfCtx && OUT_OF_CONTEXT_CLASS)}
                        >
                          <ArtifactsStrip items={item.items} />
                        </MessageScrollerItem>
                      );
                      if (!copyBtn) return withBreak([el]);
                      return withBreak([el, <CopyRow key={`copy-${i}`} text={copyBtn} />]);
                    }
                    const el = (
                      <MessageScrollerItem
                        key={item.id}
                        messageId={item.id}
                        scrollAnchor={!showWorking && i === grouped.length - 1}
                        className={cn(copyBtn && "peer/turn", outOfCtx && OUT_OF_CONTEXT_CLASS)}
                      >
                        <MessageRow
                          msg={item as ChatMessage}
                          mode={transcriptMode}
                          droppedFromContext={outOfContext.has(
                            (item as ChatMessage).id,
                          )}
                          onToggleContext={
                            isStreaming ? undefined : toggleTurnContext
                          }
                        />
                      </MessageScrollerItem>
                    );
                    if (!copyBtn) return withBreak([el]);
                    return withBreak([el, <CopyRow key={`copy-${i}`} text={copyBtn} />]);
                  })}

                  {showWorking && (
                    // NOT a scroll anchor, though it is the newest thing on
                    // screen and the temptation is obvious.
                    //
                    // An anchor means "when items arrive, put THIS at the top
                    // of the viewport", and the scroller obeys it whether or
                    // not the reader has scrolled away. The working row is
                    // last, so every new tool call during a run threw the
                    // feed to the very end — you could not read what the
                    // model had just done while it was doing the next thing.
                    //
                    // Without it the scroller falls back to the rule that was
                    // wanted all along: follow the bottom for someone who is
                    // AT the bottom, and leave everyone else where they are.
                    <MessageScrollerItem messageId="__working">
                      <WorkingRow messages={messages} startedAt={turnStartedAt} />
                    </MessageScrollerItem>
                  )}

                  {/* Handed to the RUNNING turn — visible at once, replaced by
                      the real bubble when main delivers it at the next step
                      boundary. No remove button: it is already the model's. */}
                  {pendingInjections.map((msg) => (
                    <MessageScrollerItem
                      key={`pi-${msg.id}`}
                      messageId={`pi-${msg.id}`}
                    >
                      <Message align="end">
                        <MessageContent>
                          <div className="flex flex-col items-end">
                            <div className="mb-0.5 flex items-center gap-1 text-[11px] text-muted-foreground/70">
                              <CornerDownLeft className="size-3" />
                              Joining the run…
                            </div>
                            {(msg.attachments?.length ?? 0) > 0 && (
                              <AttachmentChips attachments={msg.attachments!} />
                            )}
                            {msg.content && (
                              <Bubble variant="secondary" align="end">
                                <BubbleContent className="whitespace-pre-wrap dark:bg-white/[0.06] glass-panel rounded-xl border border-dashed border-border opacity-70">
                                  {msg.content}
                                </BubbleContent>
                              </Bubble>
                            )}
                          </div>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ))}

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
                              {(msg.attachments?.length ?? 0) > 0 && (
                                <AttachmentChips attachments={msg.attachments!} />
                              )}
                              {msg.content && (
                                <Bubble variant="secondary" align="end">
                                  <BubbleContent className="whitespace-pre-wrap dark:bg-white/[0.06] glass-panel rounded-xl border border-dashed border-border opacity-70">
                                    {msg.content}
                                  </BubbleContent>
                                </Bubble>
                              )}
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

      {/* Plan approval — modal; the model is waiting on the verdict. */}

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
          <PlanFallbackBar />
          <MessageInput onOpenProviders={onOpenProvidersSettings} />
        </>
      )}
    </div>
  );
}

/**
 * Shows approval requests one at a time.
 *
 * A QUEUE, not a slot. This used to hold a single request in state, so a
 * second one replaced the first: its dialog vanished from the screen while
 * main still waited on it, and five minutes later that tool was denied for a
 * question nobody was ever shown. Concurrent chats and concurrency-safe tools
 * in one turn both produce overlapping requests, so this is the normal case,
 * not an edge one.
 */
export function PermissionHost(): JSX.Element | null {
  const [queue, setQueue] = useState<PermissionRequest[]>([]);

  useEffect(() => {
    const bridge = (window as unknown as { electronAPI?: ElectronAPI })
      .electronAPI;
    if (!bridge?.permissions) return;
    return bridge.permissions.onRequest((req: PermissionRequest) =>
      setQueue((prev) =>
        // Main can re-send on a reconnect; answering the same id twice would
        // apply one decision to a request that is already gone.
        prev.some((r) => r.id === req.id) ? prev : [...prev, req],
      ),
    );
  }, []);

  const request = queue[0];
  if (!request) return null;

  return (
    <PermissionDialog
      key={request.id}
      request={request}
      pendingCount={queue.length - 1}
      onDecision={(decision) => {
        const bridge = (window as unknown as { electronAPI?: ElectronAPI })
          .electronAPI;
        bridge?.permissions.respond(request.id, decision);
        setQueue((prev) => prev.filter((r) => r.id !== request.id));
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
