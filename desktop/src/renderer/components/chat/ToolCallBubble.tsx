import { useState } from "react";
import {
  Check,
  ChevronRight,
  Circle,
  FilePlus,
  FileText,
  Loader2,
  Pencil,
  Search,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ToolCall } from "@/types/chat";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { cn } from "@/lib/utils";

const TOOL_ICONS: Record<string, LucideIcon> = {
  Read: FileText,
  Write: FilePlus,
  Edit: Pencil,
  MultiEdit: Pencil,
  Bash: Terminal,
  PowerShell: Terminal,
  Glob: Search,
  Grep: Search,
};

function iconFor(name: string): LucideIcon {
  return TOOL_ICONS[name] ?? Wrench;
}

function inputPreview(input: Record<string, unknown>): string {
  for (const key of ["file_path", "path", "command", "pattern", "query", "url"]) {
    const v = input[key];
    if (typeof v === "string") return v;
  }
  const keys = Object.keys(input);
  return keys.length ? JSON.stringify(input) : "";
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

export function ToolCallBubble({
  toolCall,
}: {
  toolCall: ToolCall;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const Icon = iconFor(toolCall.name);
  const preview = inputPreview(toolCall.input);
  const hasDetails =
    Object.keys(toolCall.input).length > 0 || Boolean(toolCall.output);

  return (
    <div className="w-full">
      <Marker variant="border" asChild>
        <button
          type="button"
          onClick={() => hasDetails && setOpen((o) => !o)}
          className={cn("w-full", hasDetails && "cursor-pointer")}
        >
          <MarkerIcon>
            <Icon className="size-4" />
          </MarkerIcon>
          <MarkerContent className="flex min-w-0 items-center gap-2">
            <span className="font-medium text-foreground">{toolCall.name}</span>
            {preview && (
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                {preview}
              </span>
            )}
          </MarkerContent>
          <StatusIcon status={toolCall.status} />
          {hasDetails && (
            <ChevronRight
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
          )}
        </button>
      </Marker>

      {open && hasDetails && (
        <div className="mt-2 space-y-2">
          {Object.keys(toolCall.input).length > 0 && (
            <pre className="max-h-60 overflow-auto rounded-lg border border-border bg-muted/50 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          )}
          {toolCall.output && (
            <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-card p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {toolCall.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
