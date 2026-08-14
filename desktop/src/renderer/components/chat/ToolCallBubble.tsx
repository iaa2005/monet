import { useMemo, useState, memo } from "react";
import {
  Bot,
  Check,
  ChevronRight,
  Circle,
  Loader2,
  Maximize2,
  X,
} from "lucide-react";
import type { ChatMessage, ToolCall } from "@/types/chat";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import { CodeBlock, CopyButton } from "./CodeBlock";
import { PlanDocCard } from "./PlanDocCard";
import { rendersAsCard } from "./turn-state";
import { MarkdownViewer } from "./MarkdownViewer";
import { diffStats, langFromPath } from "./diff-core";
import { Spinner } from "./WorkingIndicator";
import { ArtifactThumb, KindIcon } from "@/components/ArtifactsPanel";
import { viewArtifact } from "@/components/artifact-actions";

// Sandbox tool output carries one line per produced file:
//   [artifact] <mediaType> <name> :: <path>   — delivered to the user (chip)
//   [file]     <mediaType> <name> :: <path>   — working file (no chip; the
//                                               plain-text summary line says
//                                               what was written)
// Both are machinery, so both are stripped from the visible text; only the
// delivered ones become thumbnails/chips. The "Markdown: …" helper line that
// follows a marker is machinery too.
const SANDBOX_FILE_RE = /^\[(artifact|file)\]\s+(\S+)\s+(.+?)\s+::\s+(.+)$/;
const MARKDOWN_HINT_RE = /^Markdown:\s+!\[/;

function kindOfMime(mime: string): "image" | "audio" | "video" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

/** Split sandbox output into delivered files (chips) + the visible text log. */
function parseSandboxOutput(output: string): {
  files: { name: string; mediaType: string; path: string }[];
  text: string;
} {
  const files: { name: string; mediaType: string; path: string }[] = [];
  const rest: string[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    const m = SANDBOX_FILE_RE.exec(trimmed);
    if (m) {
      if (m[1] === "artifact")
        files.push({ mediaType: m[2], name: m[3], path: m[4] });
      // [file] lines drop silently — the tool's own "Created …" summary
      // already names what was written.
    } else if (!MARKDOWN_HINT_RE.test(trimmed)) {
      rest.push(line);
    }
  }
  return { files, text: rest.join("\n").trim() };
}

function SandboxOutput({
  output,
  inGroup,
  chips = true,
}: {
  output: string;
  inGroup?: boolean;
  /** DeliverFiles passes false: its whole output IS a delivery, which the
   * end-of-turn card already presents — a chip in the bubble would show the
   * same file twice within one screen. */
  chips?: boolean;
}): JSX.Element {
  const { files, text } = useMemo(() => parseSandboxOutput(output), [output]);
  return (
    <div className="space-y-2">
      {text && (
        <CodeBlock
          code={text}
          language="text"
          maxHeight={280}
          bare={inGroup}
          className={inGroup ? "my-0 border-0 rounded-none" : ""}
        />
      )}
      {chips && files.length > 0 && (
        <div className="flex flex-wrap gap-2 p-2">
          {files.map((f, i) => {
            const kind = kindOfMime(f.mediaType);
            const meta = {
              name: f.name,
              mediaType: f.mediaType,
              kind,
              path: f.path,
            };
            return kind === "image" ? (
              <ArtifactThumb
                key={`${i}-${f.name}`}
                a={meta}
                onClick={() => viewArtifact(meta)}
                className="max-h-72 max-w-full rounded-lg border border-border object-contain"
              />
            ) : (
              <button
                key={`${i}-${f.name}`}
                type="button"
                onClick={() => viewArtifact(meta)}
                title={`View ${f.name}`}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12px] transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              >
                <KindIcon kind={kind} />
                <span className="max-w-52 truncate">{f.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

type TranscriptMode = "normal" | "thinking" | "verbose" | "summary";

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

/** Human-friendly tool names — match the official desktop style. */
const HUMAN_NAMES: Record<string, string> = {
  Bash: "Ran command",
  PowerShell: "Ran PowerShell",
  Read: "Read",
  Write: "Wrote",
  Edit: "Edited",
  MultiEdit: "Edited",
  Grep: "Searched",
  Glob: "Found files",
  TodoWrite: "Updated plan",
  UpdatePlan: "Updated the plan document",
  Task: "Delegated task",
  RunPython: "Ran Python",
  DeliverFiles: "Delivered files",
  BrowserNavigate: "Opened page",
  BrowserReadPage: "Read page",
  BrowserInput: "Browser",
  BrowserScreenshot: "Screenshot",
  Computer: "Computer",
};

function humanName(name: string): string {
  return HUMAN_NAMES[name] ?? name;
}

/** Short one-line preview of the tool's primary argument */
function inputPreview(name: string, input: Record<string, unknown>): string {
  const str = (k: string): string | undefined =>
    typeof input[k] === "string" ? (input[k] as string) : undefined;
  if (name === "Bash" || name === "PowerShell") return str("command") ?? "";
  // `name` too: in a Home chat Read/Write/Edit are the sandbox tools, and
  // they take a sandbox-relative `name` rather than an absolute file_path.
  const path = str("file_path") ?? str("path") ?? str("name");
  if (
    name === "Read" ||
    name === "Write" ||
    name === "Edit" ||
    name === "MultiEdit"
  )
    return path ? baseName(path) : "";
  if (name === "Grep" || name === "Glob") {
    const pat = str("pattern") ?? "";
    return pat;
  }
  const first =
    str("file_path") ??
    str("path") ??
    str("name") ??
    str("command") ??
    str("pattern") ??
    str("query") ??
    str("url");
  return first ?? "";
}

/** Extract file path from tool input for clickable link. */
function filePath(input: Record<string, unknown>): string | undefined {
  const str = (k: string): string | undefined =>
    typeof input[k] === "string" ? (input[k] as string) : undefined;
  return str("file_path") ?? str("path");
}

function StatusIcon({ status }: { status: ToolCall["status"] }): JSX.Element {
  switch (status) {
    case "pending":
      return <Circle className="size-3.5 text-muted-foreground" />;
    case "running":
      return <Loader2 className="size-3.5 animate-spin text-foreground" />;
    case "done":
      return (
        <Check className="size-3.5 text-green-text" />
      );
    case "error":
      return <X className="size-3.5 text-red-text" />;
  }
}

/**
 * A tool's input and its output, as ONE block.
 *
 * They were two cards with a gap between them, which reads as two
 * unrelated things — a command and, separately, some text. A call is one
 * event: the thing asked for and what came back. So they share a panel and
 * are divided by a line rather than by air.
 *
 * The language belongs to the INPUT and is labelled there; output has no
 * language worth naming (it is whatever the tool printed).
 *
 * Each pane carries its own copy button, because copying a command and
 * copying its output are different intentions and a single button would
 * have to guess. They stay out of the way until the pointer is on the
 * pane, since a block nobody is looking at should be code, not chrome.
 */
function ToolPane({
  label,
  copyText,
  divider,
  children,
}: {
  /** Shown always — this is the language, and it names the pane. */
  label?: string;
  copyText: string;
  /** Not the first pane: separated by a rule, not a gap. */
  divider?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className={cn("group/pane relative", divider && "border-t border-border")}>
      {label ? (
        <div className="flex h-7 items-center justify-between border-b border-border/60 bg-muted/40 pl-3 pr-1">
          <span className="font-mono text-[11px] text-muted-foreground">
            {label}
          </span>
          <span className="opacity-0 transition-opacity group-hover/pane:opacity-100">
            <CopyButton text={copyText} />
          </span>
        </div>
      ) : (
        // No label to hang it on, so it floats over the top-right corner —
        // where the eye already goes, and where it covers no first line
        // that a scrollbar was not covering anyway.
        <span className="absolute right-1 top-1 z-10 rounded-md bg-card/90 opacity-0 backdrop-blur transition-opacity group-hover/pane:opacity-100">
          <CopyButton text={copyText} />
        </span>
      )}
      {children}
    </div>
  );
}

/** The panel the panes live in. `bare` inside a group, where the group card
 * already draws the border. */
function ToolPanes({
  bare,
  children,
}: {
  bare?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      className={cn(
        "overflow-hidden",
        bare
          ? "my-0"
          : "glass-panel my-3 rounded-lg border border-border bg-card",
      )}
    >
      {children}
    </div>
  );
}

function ToolDetail({
  toolCall,
  inGroup,
}: {
  toolCall: ToolCall;
  inGroup?: boolean;
}): JSX.Element {
  const { name, input, output } = toolCall;
  const str = (k: string): string | undefined =>
    typeof input[k] === "string" ? (input[k] as string) : undefined;

  if ((name === "Edit" || name === "MultiEdit") && str("old_string") != null) {
    return (
      <CodeBlock
        code={str("new_string") ?? ""}
        oldCode={str("old_string") ?? ""}
        language={langFromPath(str("file_path") ?? "")}
        bare={inGroup}
        className={inGroup ? "my-0 border-0 rounded-none" : ""}
      />
    );
  }

  // A TodoWrite call expanded to its own result text and nothing else:
  // "Todos have been modified successfully. Ensure that you continue to use
  // the todo list…" — a message addressed to the model, shown to the person.
  // The list itself is right there in the input, so show that instead.
  if (name === "TodoWrite" && Array.isArray(input.todos)) {
    const todos = input.todos as {
      content?: unknown;
      status?: unknown;
      activeForm?: unknown;
    }[];
    const mark = (s: unknown): string =>
      s === "completed" ? "x" : s === "in_progress" ? "-" : " ";
    const md = todos
      .map((t) => {
        const text =
          typeof t.content === "string"
            ? t.content
            : typeof t.activeForm === "string"
              ? t.activeForm
              : "";
        return `- [${mark(t.status)}] ${text}`;
      })
      .join("\n");
    return (
      <ToolPanes bare={inGroup}>
        <ToolPane copyText={md}>
          <div className="px-3 py-2 text-sm">
            <MarkdownViewer content={md} />
          </div>
        </ToolPane>
      </ToolPanes>
    );
  }

  if (name === "Write" && str("content") != null) {
    return (
      <CodeBlock
        code={str("content") ?? ""}
        oldCode=""
        language={langFromPath(str("file_path") ?? "")}
        bare={inGroup}
        className={inGroup ? "my-0 border-0 rounded-none" : ""}
      />
    );
  }

  if (name === "RunPython") {
    const sent = str("code");
    const sentLang = "python";
    return (
      <ToolPanes bare={inGroup}>
        {sent && (
          <ToolPane label={sentLang || "text"} copyText={sent}>
            <CodeBlock
              code={sent}
              language={sentLang}
              bare
              className="my-0 rounded-none border-0"
            />
          </ToolPane>
        )}
        {output && (
          <ToolPane copyText={output} divider={!!sent}>
            <SandboxOutput output={output} inGroup />
          </ToolPane>
        )}
      </ToolPanes>
    );
  }

  const shellLang =
    name === "Bash" ? "bash" : name === "PowerShell" ? "powershell" : "";
  const fp = str("file_path") ?? str("path");
  const outLang = fp ? langFromPath(fp) : "text";

  const command =
    name === "Bash" || name === "PowerShell" ? str("command") : undefined;
  const args =
    !output && !command && Object.keys(input).length > 0
      ? JSON.stringify(input, null, 2)
      : undefined;

  return (
    <ToolPanes bare={inGroup}>
      {command && (
        <ToolPane label={shellLang} copyText={command}>
          <CodeBlock
            code={command}
            language={shellLang}
            bare
            className="my-0 rounded-none border-0"
          />
        </ToolPane>
      )}
      {args && (
        <ToolPane label="json" copyText={args}>
          <CodeBlock
            code={args}
            language="json"
            bare
            className="my-0 rounded-none border-0"
          />
        </ToolPane>
      )}
      {output && (
        <ToolPane copyText={output} divider={!!command}>
          {output.includes("[artifact]") || output.includes("[file]") ? (
            // Any tool that produced files (Computer/Browser screenshots,
            // sandbox writes) goes through the marker parser: delivered files
            // render as thumbnails, working files vanish from the log.
            <SandboxOutput
              output={output}
              inGroup
              chips={name !== "DeliverFiles"}
            />
          ) : (
            <CodeBlock
              code={output}
              language={outLang}
              maxHeight={320}
              bare
              className="my-0 rounded-none border-0"
            />
          )}
        </ToolPane>
      )}
    </ToolPanes>
  );
}

function FilePathLink({ path }: { path: string }): JSX.Element {
  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    const name = path.split(/[/\\]/).pop() || path;
    useChatStore.getState().openViewer({
      name,
      path,
      mediaType: "application/octet-stream",
      kind: "file",
      source: "file",
    });
  };
  // Rendered inside the ToolRow header <button>, so this must NOT be a
  // <button> itself (nested buttons are invalid HTML — React logs an error).
  return (
    <span
      role="link"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter") handleClick(e as unknown as React.MouseEvent);
      }}
      className="cursor-pointer font-mono text-xs text-foreground hover:underline"
      title={path}
    >
      {baseName(path)}
    </span>
  );
}

/** Single collapsed tool row — used in Normal mode groups and standalone. */
function ToolRow({
  toolCall,
  open,
  onToggle,
  compact,
  inGroup,
}: {
  toolCall: ToolCall;
  open: boolean;
  onToggle: () => void;
  compact?: boolean;
  inGroup?: boolean;
}): JSX.Element {
  const human = humanName(toolCall.name);
  const preview = inputPreview(toolCall.name, toolCall.input);
  const fp = filePath(toolCall.input);
  const hasDetails =
    Object.keys(toolCall.input).length > 0 || Boolean(toolCall.output);
  const isEdit =
    (toolCall.name === "Edit" || toolCall.name === "MultiEdit") &&
    typeof toolCall.input.old_string === "string";
  const isWrite =
    toolCall.name === "Write" && typeof toolCall.input.content === "string";
  const stats = isEdit
    ? diffStats(
        String(toolCall.input.old_string ?? ""),
        String(toolCall.input.new_string ?? ""),
      )
    : isWrite
      ? diffStats("", String(toolCall.input.content ?? ""))
      : null;

  return (
    <div>
      <button
        type="button"
        onClick={hasDetails ? onToggle : undefined}
        className={cn(
          "mx-0 flex w-full items-center gap-2 text-left",
          inGroup && "p-2",
          hasDetails && "cursor-pointer",
        )}
      >
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {human}
        </span>
        {fp ? (
          <FilePathLink path={fp} />
        ) : preview ? (
          <span className="truncate font-mono text-xs text-foreground">
            {preview}
          </span>
        ) : null}
        {stats && (stats.added > 0 || stats.removed > 0) && (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-green-text">
              +{stats.added}
            </span>{" "}
            <span className="text-red-text">
              -{stats.removed}
            </span>
          </span>
        )}
        {toolCall.status !== "done" && <StatusIcon status={toolCall.status} />}
        {hasDetails && (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
              open && "rotate-90",
            )}
          />
        )}
      </button>

      {open && hasDetails && (
        <div className={inGroup ? "" : "mt-1.5"}>
          <ToolDetail toolCall={toolCall} inGroup={inGroup} />
        </div>
      )}
    </div>
  );
}

/** Group card — header is a plain text row, expanded content appears in a bordered card. */
function ToolGroupCard({ calls }: { calls: ToolCall[] }): JSX.Element {
  const [groupOpen, setGroupOpen] = useState(false);
  const [openIndices, setOpenIndices] = useState<Set<number>>(new Set());

  if (calls.length === 1) {
    return (
      <div>
        <ToolRow
          toolCall={calls[0]}
          open={openIndices.has(0)}
          onToggle={() =>
            setOpenIndices((prev) => {
              const next = new Set(prev);
              if (next.has(0)) next.delete(0);
              else next.add(0);
              return next;
            })
          }
        />
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setGroupOpen((o) => !o)}
        className="mx-0 flex w-full items-center gap-2 text-left cursor-pointer"
      >
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          Used {calls.length} tools
        </span>
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
            groupOpen && "rotate-90",
          )}
        />
      </button>

      {groupOpen && (
        <div className="glass-panel mt-1.5 rounded-lg border border-border bg-card overflow-hidden">
          {calls.map((tc, i) => (
            <div key={tc.id}>
              {i > 0 && <hr className="border-border/30" />}
              {tc.subAgent || tc.name === "Task" ? (
                <div className="px-3 py-2">
                  <SubAgentBubble toolCall={tc} inGroup />
                </div>
              ) : (
                <ToolRow
                  toolCall={tc}
                  open={openIndices.has(i)}
                  onToggle={() =>
                    setOpenIndices((prev) => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                  compact
                  inGroup
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Single tool call. In verbose mode it is expanded by default and reveals the
 * FULL raw input params (every argument) in addition to the semantic detail and
 * output. */
function ToolCallItem({
  toolCall,
  verbose,
}: {
  toolCall: ToolCall;
  verbose?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const effectiveOpen = verbose || open;
  const preview = inputPreview(toolCall.name, toolCall.input);
  const isEdit =
    (toolCall.name === "Edit" || toolCall.name === "MultiEdit") &&
    typeof toolCall.input.old_string === "string";
  const isWrite =
    toolCall.name === "Write" && typeof toolCall.input.content === "string";
  const stats = isEdit
    ? diffStats(
        String(toolCall.input.old_string ?? ""),
        String(toolCall.input.new_string ?? ""),
      )
    : isWrite
      ? diffStats("", String(toolCall.input.content ?? ""))
      : null;
  const hasDetails =
    Object.keys(toolCall.input).length > 0 || Boolean(toolCall.output);

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((o) => !o)}
        className={cn(
          "mx-0 flex w-full items-center gap-2 text-left",
          hasDetails && "cursor-pointer",
        )}
      >
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {toolCall.name}
        </span>
        {preview ? (
          <span className="truncate font-mono text-xs text-foreground">
            {preview}
          </span>
        ) : null}
        {stats && (stats.added > 0 || stats.removed > 0) && (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-green-text">
              +{stats.added}
            </span>{" "}
            <span className="text-red-text">
              -{stats.removed}
            </span>
          </span>
        )}
        {toolCall.status !== "done" && <StatusIcon status={toolCall.status} />}
        {hasDetails && (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
              effectiveOpen && "rotate-90",
            )}
          />
        )}
      </button>

      {effectiveOpen && hasDetails && (
        <div className="mt-1.5 space-y-1.5">
          {verbose && Object.keys(toolCall.input).length > 0 && (
            <div>
              <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Parameters
              </div>
              <CodeBlock
                code={JSON.stringify(toolCall.input, null, 2)}
                language="json"
                maxHeight={280}
              />
            </div>
          )}
          <ToolDetail toolCall={toolCall} />
        </div>
      )}
    </div>
  );
}

/** A lone tool call in Normal mode — expandable just like grouped ones
 * (the old version hardcoded open={false} with a no-op toggle). */
function SingleToolRow({ toolCall }: { toolCall: ToolCall }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <ToolRow
      toolCall={toolCall}
      open={open}
      onToggle={() => setOpen((o) => !o)}
    />
  );
}

/**
 * The child's activity, rendered with the SAME components as the main chat:
 * each tool call is an expandable ToolCallBubble; each assistant chunk is
 * markdown. So the details (inputs, outputs, diffs) are always inspectable.
 */
export function SubAgentTranscript({
  messages,
  running,
}: {
  messages: ChatMessage[];
  running: boolean;
}): JSX.Element {
  return (
    <div className="space-y-2">
      {messages.map((m) =>
        m.role === "tool" && m.toolCall ? (
          <ToolCallBubble key={m.id} toolCall={m.toolCall} mode="normal" />
        ) : m.content ? (
          <div key={m.id} className="text-sm leading-relaxed text-foreground">
            <MarkdownViewer content={m.content} />
          </div>
        ) : null,
      )}
      {messages.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {running ? (
            <>
              <Spinner className="size-3" />
              <span>Working…</span>
            </>
          ) : (
            "No output."
          )}
        </div>
      )}
    </div>
  );
}

const ICON_BTN =
  "rounded p-0.5 text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]";

/**
 * Nested "agent card" for a Task tool call. Shows the child's full transcript
 * (same tool/markdown components as the main chat), collapsible inline, and
 * expandable to a full-screen overlay you can dismiss back to the chat.
 */
function SubAgentBubble({ toolCall, inGroup }: { toolCall: ToolCall; inGroup?: boolean }): JSX.Element {
  const sa = toolCall.subAgent;
  const agentType = sa?.agentType ?? "general-purpose";
  const description =
    sa?.description ??
    (typeof toolCall.input.description === "string"
      ? (toolCall.input.description as string)
      : undefined);
  const running = sa ? sa.status === "running" : toolCall.status !== "done";
  const messages = sa?.messages ?? [];
  const [collapsed, setCollapsed] = useState(false);

  // A reference, not a copy: the panel looks the state up live, so a child
  // that is still working keeps filling the panel in.
  const expand = (): void => {
    const s = useChatStore.getState();
    s.openExpandedSubAgent({
      sessionId: s.currentSessionId ?? "default",
      toolCallId: toolCall.id,
    });
  };

  const header = (
    <div className="flex items-center gap-2">
      <Bot className="size-4 shrink-0 text-violet-500" />
      <span className="shrink-0 text-sm font-medium text-foreground">
        Sub-agent
      </span>
      <span className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 text-[11px] font-medium text-violet-600 dark:text-violet-400">
        {agentType}
      </span>
      {sa?.background && (
        <span
          className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
          title="Runs in the background — its report is delivered when it finishes"
        >
          background
        </span>
      )}
      {description && (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {description}
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {running ? (
          <Loader2 className="size-3.5 animate-spin text-foreground" />
        ) : (
          <Check className="size-3.5 text-green-text" />
        )}
        <button
          type="button"
          onClick={expand}
          title="Expand to fill the chat area"
          className={ICON_BTN}
        >
          <Maximize2 className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Expand" : "Collapse"}
          className={ICON_BTN}
        >
          <ChevronRight
            className={cn(
              "size-4 transition-transform",
              !collapsed && "rotate-90",
            )}
          />
        </button>
      </div>
    </div>
  );

  const body = (
    <>
      {header}
      {!collapsed && (
        <div className="mt-2 border-l-2 border-violet-500/20 pl-3">
          <SubAgentTranscript messages={messages} running={running} />
        </div>
      )}
    </>
  );

  return (
    <div className={inGroup ? "" : "glass-panel rounded-lg border border-border bg-card px-3 py-2"}>
      {body}
    </div>
  );
}

interface ToolCallBubbleProps {
  toolCall: ToolCall;
  /** When in a grouped set (consecutive tool calls), group members are provided. */
  groupMembers?: ToolCall[];
  mode?: TranscriptMode;
}

function ToolCallBubbleImpl({
  toolCall,
  groupMembers,
  mode = "verbose",
}: ToolCallBubbleProps): JSX.Element {
  // The plan card outranks every mode filter: while its approval round-trip
  // is open it carries the Build buttons, and a hidden card would strand the
  // turn until the timeout sends "keep planning".
  if (rendersAsCard(toolCall.name)) {
    return (
      <div className="space-y-1.5">
        <PlanDocCard toolCall={toolCall} />
        {mode === "normal" && groupMembers && groupMembers.length > 0 && (
          <ToolGroupCard calls={groupMembers} />
        )}
      </div>
    );
  }

  if (mode === "summary") return <span />;

  // Task calls render as a live nested agent card (in every non-summary mode).
  // Any tools grouped after it still render normally below.
  if (toolCall.subAgent || toolCall.name === "Task") {
    return (
      <div className="space-y-1.5">
        <SubAgentBubble toolCall={toolCall} />
        {mode === "normal" && groupMembers && groupMembers.length > 0 && (
          <ToolGroupCard calls={groupMembers} />
        )}
      </div>
    );
  }

  if (mode === "normal" && groupMembers && groupMembers.length > 0) {
    return <ToolGroupCard calls={[toolCall, ...groupMembers]} />;
  }

  // Normal and Thinking both use the compact, collapsed row — Thinking's real
  // distinction is the reasoning block rendered on the assistant message.
  if (mode === "normal" || mode === "thinking") {
    return <SingleToolRow toolCall={toolCall} />;
  }

  // Verbose: individual items, expanded, revealing full params + output.
  return <ToolCallItem toolCall={toolCall} verbose />;
}

function sameMembers(a?: ToolCall[], b?: ToolCall[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

/** Memoized by tool-call identity: groupMessages() rebuilds the group arrays
 * on every streaming flush, but the ToolCall objects themselves only change
 * when their status/output changes — comparing element-wise keeps finished
 * tool cards (and their highlighted CodeBlocks) from re-rendering per flush. */
export const ToolCallBubble = memo(
  ToolCallBubbleImpl,
  (prev, next) =>
    prev.toolCall === next.toolCall &&
    prev.mode === next.mode &&
    sameMembers(prev.groupMembers, next.groupMembers),
);
