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
import { CodeBlock } from "./CodeBlock";
import { MarkdownViewer } from "./MarkdownViewer";
import { diffStats, langFromPath } from "./diff-core";
import {
  ArtifactThumb,
  KindIcon,
  viewArtifact,
} from "@/components/ArtifactsPanel";

// Sandbox tool output carries one line per produced file:
//   [artifact] <mediaType> <name> :: <absolute path>
const SANDBOX_FILE_RE = /^\[artifact\]\s+(\S+)\s+(.+?)\s+::\s+(.+)$/;

function kindOfMime(mime: string): "image" | "audio" | "video" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

/** Split RunPython output into produced files + the remaining text log. */
function parseSandboxOutput(output: string): {
  files: { name: string; mediaType: string; path: string }[];
  text: string;
} {
  const files: { name: string; mediaType: string; path: string }[] = [];
  const rest: string[] = [];
  for (const line of output.split("\n")) {
    const m = SANDBOX_FILE_RE.exec(line.trim());
    if (m) files.push({ mediaType: m[1], name: m[2], path: m[3] });
    else rest.push(line);
  }
  return { files, text: rest.join("\n").trim() };
}

function SandboxOutput({
  output,
  inGroup,
}: {
  output: string;
  inGroup?: boolean;
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
          className={inGroup ? "border-none bg-transparent my-0" : ""}
        />
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
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
  Task: "Delegated task",
  RunPython: "Ran Python",
  SandboxList: "Listed sandbox files",
  SandboxRead: "Read sandbox file",
  SandboxWrite: "Wrote sandbox file",
  BrowserNavigate: "Opened page",
  BrowserReadPage: "Read page",
  BrowserClick: "Clicked",
  BrowserType: "Typed",
  BrowserScroll: "Scrolled",
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
  const path = str("file_path") ?? str("path");
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
      />
    );
  }

  if (name === "Write" && str("content") != null) {
    return <CodeBlock code={str("content") ?? ""} oldCode="" language={langFromPath(str("file_path") ?? "")} />;
  }

  if (name === "RunPython" || name === "SandboxWrite") {
    return (
      <div className="space-y-2">
        {name === "RunPython" && str("code") && (
          <CodeBlock
            code={str("code") ?? ""}
            language="python"
            bare={inGroup}
            className={inGroup ? "border-none bg-transparent my-0" : ""}
          />
        )}
        {name === "SandboxWrite" && str("content") && (
          <CodeBlock
            code={str("content") ?? ""}
            language={langFromPath(str("name") ?? "")}
            maxHeight={280}
            bare={inGroup}
            className={inGroup ? "border-none bg-transparent my-0" : ""}
          />
        )}
        {output && <SandboxOutput output={output} inGroup={inGroup} />}
      </div>
    );
  }

  const shellLang =
    name === "Bash" ? "bash" : name === "PowerShell" ? "powershell" : "";
  const fp = str("file_path") ?? str("path");
  const outLang = fp ? langFromPath(fp) : "text";

  return (
    <div className="space-y-2">
      {(name === "Bash" || name === "PowerShell") && str("command") && (
        <CodeBlock
          code={str("command") ?? ""}
          language={shellLang}
          bare={inGroup}
          className={inGroup ? "border-none bg-transparent my-0" : ""}
        />
      )}
      {output && output.includes("[artifact]") ? (
        // Any tool that produced files (Computer/Browser screenshots, sandbox
        // writes) renders them as thumbnails instead of raw marker lines.
        <SandboxOutput output={output} inGroup={inGroup} />
      ) : output ? (
        <CodeBlock
          code={output}
          language={outLang}
          maxHeight={320}
          bare={inGroup}
          className={inGroup ? "border-none bg-transparent my-0" : ""}
        />
      ) : Object.keys(input).length > 0 &&
        name !== "Bash" &&
        name !== "PowerShell" ? (
        <CodeBlock
          code={JSON.stringify(input, null, 2)}
          language="json"
          bare={inGroup}
          className={inGroup ? "border-none bg-transparent my-0" : ""}
        />
      ) : null}
    </div>
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
          hasDetails && "cursor-pointer",
        )}
      >
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {human}
        </span>
        {fp ? (
          <FilePathLink path={fp} />
        ) : preview ? (
          <span className="truncate font-mono text-xs text-muted-foreground">
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
        <div className={inGroup ? "mt-1 pl-1" : "mt-1.5"}>
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
        <div className="glass-panel mt-1.5 rounded-lg border border-border bg-card px-2.5 py-2">
          {calls.map((tc, i) => (
            <div key={tc.id}>
              {i > 0 && <hr className="-mx-2.5 my-1.5 border-border/30" />}
              {tc.subAgent || tc.name === "Task" ? (
                <SubAgentBubble toolCall={tc} inGroup />
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
          <span className="truncate font-mono text-xs text-muted-foreground">
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
        <div className="text-xs text-muted-foreground">
          {running ? "Working…" : "No output."}
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

  const expand = (): void => {
    useChatStore.getState().openExpandedSubAgent({
      agentType,
      description,
      status: running ? "running" : "done",
      messages,
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
