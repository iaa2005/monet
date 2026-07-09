import { useState } from "react";
import { Check, ChevronRight, Circle, Loader2, X, Wrench } from "lucide-react";
import type { ToolCall } from "@/types/chat";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./CodeBlock";
import { InlineDiff, diffStats } from "./InlineDiff";

type TranscriptMode = "normal" | "thinking" | "verbose" | "summary";

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

/** Human-friendly tool names — match official Claude Code style. */
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
        <Check className="size-3.5 text-emerald-600 dark:text-emerald-500" />
      );
    case "error":
      return <X className="size-3.5 text-destructive" />;
  }
}

/** Map file extension to syntax-highlighter language id. */
function langFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    scala: "scala",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    swift: "swift",
    css: "css",
    scss: "scss",
    less: "less",
    html: "html",
    xml: "xml",
    svg: "svg",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    ps1: "powershell",
    md: "markdown",
    txt: "text",
    log: "text",
    dockerfile: "docker",
    makefile: "makefile",
  };
  return map[ext] || map[path.toLowerCase()] || "text";
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
      <InlineDiff
        oldText={str("old_string") ?? ""}
        newText={str("new_string") ?? ""}
      />
    );
  }

  if (name === "Write" && str("content") != null) {
    return <InlineDiff oldText="" newText={str("content") ?? ""} />;
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
      {output ? (
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
    const api = (
      window as unknown as {
        electronAPI?: { files?: { openPath?: (p: string) => void } };
      }
    ).electronAPI;
    api?.files?.openPath?.(path);
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
      className="cursor-pointer font-mono text-xs text-link hover:underline"
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
          "mx-0 flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors",
          hasDetails &&
            "cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
          compact && "py-0.5",
        )}
      >
        <span className="shrink-0 text-sm font-medium text-foreground">
          {human}
        </span>
        {fp ? (
          <>
            <FilePathLink path={fp} />
            <span className="flex-1" />
          </>
        ) : preview ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {preview}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {!fp && !preview && <span className="flex-1" />}
        {stats && (stats.added > 0 || stats.removed > 0) && (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-emerald-600 dark:text-emerald-500">
              +{stats.added}
            </span>{" "}
            <span className="text-red-600 dark:text-red-500">
              -{stats.removed}
            </span>
          </span>
        )}
        <StatusIcon status={toolCall.status} />
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
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  if (calls.length === 1) {
    return (
      <div>
        <ToolRow
          toolCall={calls[0]}
          open={openIdx === 0}
          onToggle={() => setOpenIdx((o) => (o === 0 ? null : 0))}
        />
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setGroupOpen((o) => !o)}
        className="mx-0 flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      >
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">
          Used {calls.length} tools
        </span>
        <ChevronRight
          className={cn(
            "ml-auto size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
            groupOpen && "rotate-90",
          )}
        />
      </button>

      {groupOpen && (
        <div className="mt-1.5 rounded-lg border border-border bg-black/[0.02] px-2.5 py-2 dark:bg-white/[0.02]">
          {calls.map((tc, i) => (
            <div key={tc.id}>
              {i > 0 && <hr className="-mx-2.5 my-1.5 border-border/30" />}
              <ToolRow
                toolCall={tc}
                open={openIdx === i}
                onToggle={() => setOpenIdx((o) => (o === i ? null : i))}
                compact
                inGroup
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Single tool call (legacy / verbose mode). */
function ToolCallItem({ toolCall }: { toolCall: ToolCall }): JSX.Element {
  const [open, setOpen] = useState(false);
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
          "mx-0 flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors",
          hasDetails &&
            "cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
        )}
      >
        <span className="shrink-0 text-sm font-medium text-foreground">
          {toolCall.name}
        </span>
        {preview ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {preview}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {stats && (stats.added > 0 || stats.removed > 0) && (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-emerald-600 dark:text-emerald-500">
              +{stats.added}
            </span>{" "}
            <span className="text-red-600 dark:text-red-500">
              -{stats.removed}
            </span>
          </span>
        )}
        <StatusIcon status={toolCall.status} />
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
        <div className="mt-1.5">
          <ToolDetail toolCall={toolCall} />
        </div>
      )}
    </div>
  );
}

interface ToolCallBubbleProps {
  toolCall: ToolCall;
  /** When in a grouped set (consecutive tool calls), group members are provided. */
  groupMembers?: ToolCall[];
  mode?: TranscriptMode;
}

export function ToolCallBubble({
  toolCall,
  groupMembers,
  mode = "verbose",
}: ToolCallBubbleProps): JSX.Element {
  if (mode === "summary") return <span />;

  if (mode === "normal" && groupMembers && groupMembers.length > 0) {
    return <ToolGroupCard calls={[toolCall, ...groupMembers]} />;
  }

  if (mode === "normal") {
    return <ToolRow toolCall={toolCall} open={false} onToggle={() => {}} />;
  }

  // Verbose / Thinking: legacy individual items with raw names
  return <ToolCallItem toolCall={toolCall} />;
}
