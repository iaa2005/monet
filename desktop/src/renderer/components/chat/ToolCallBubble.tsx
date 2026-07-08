import { useState } from "react";
import { Check, ChevronRight, Circle, Loader2, X } from "lucide-react";
import type { ToolCall } from "@/types/chat";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./CodeBlock";
import { InlineDiff, diffStats } from "./InlineDiff";

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

/** Short one-line preview of the tool's primary argument, shown in the header. */
function inputPreview(name: string, input: Record<string, unknown>): string {
  const str = (k: string): string | undefined =>
    typeof input[k] === "string" ? (input[k] as string) : undefined;
  if (name === "Bash" || name === "PowerShell") return str("command") ?? "";
  const path = str("file_path") ?? str("path");
  if (name === "Read" || name === "Write" || name === "Edit" || name === "MultiEdit")
    return path ? baseName(path) : "";
  if (name === "Grep" || name === "Glob") {
    const pat = str("pattern") ?? "";
    const inPath = str("path");
    return inPath ? `${pat}  ${baseName(inPath)}` : pat;
  }
  const first = str("file_path") ?? str("path") ?? str("command") ?? str("pattern") ?? str("query") ?? str("url");
  return first ?? "";
}

function StatusIcon({ status }: { status: ToolCall["status"] }): JSX.Element {
  switch (status) {
    case "pending":
      return <Circle className="size-3.5 text-muted-foreground" />;
    case "running":
      return <Loader2 className="size-3.5 animate-spin text-foreground" />;
    case "done":
      return <Check className="size-3.5 text-emerald-600 dark:text-emerald-500" />;
    case "error":
      return <X className="size-3.5 text-destructive" />;
  }
}

/** Expanded detail body — diff for edits, code for writes/outputs. */
function ToolDetail({ toolCall }: { toolCall: ToolCall }): JSX.Element {
  const { name, input, output } = toolCall;
  const str = (k: string): string | undefined =>
    typeof input[k] === "string" ? (input[k] as string) : undefined;

  if ((name === "Edit" || name === "MultiEdit") && str("old_string") != null) {
    return (
      <InlineDiff oldText={str("old_string") ?? ""} newText={str("new_string") ?? ""} />
    );
  }

  if (name === "Write" && str("content") != null) {
    // New file → render as an all-added diff (green "+" lines), matching Edit.
    return <InlineDiff oldText="" newText={str("content") ?? ""} />;
  }

  const shellLang =
    name === "Bash" ? "bash" : name === "PowerShell" ? "powershell" : "";

  return (
    <div className="space-y-2">
      {(name === "Bash" || name === "PowerShell") && str("command") && (
        <CodeBlock code={str("command") ?? ""} language={shellLang} />
      )}
      {output ? (
        <CodeBlock code={output} language="text" maxHeight={320} />
      ) : Object.keys(input).length > 0 &&
        name !== "Bash" &&
        name !== "PowerShell" ? (
        <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
      ) : null}
    </div>
  );
}

export function ToolCallBubble({ toolCall }: { toolCall: ToolCall }): JSX.Element {
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
          "-mx-1.5 flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors",
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
