import { useState, useEffect } from "react";
import { X, FileText } from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  oneLight,
  oneDark,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { MarkdownViewer } from "./chat/MarkdownViewer";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  css: "css",
  scss: "scss",
  less: "less",
  html: "markup",
  xml: "markup",
  svg: "markup",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  sql: "sql",
};

function langFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? "text";
}

export function FileViewer({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}): JSX.Element {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const name = path.split(/[/\\]/).pop() || path;
  const isMd = /\.(md|markdown)$/i.test(name);
  const dark = document.documentElement.classList.contains("dark");

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    api()
      ?.files.read(path)
      .then((c) => {
        if (!cancelled) setContent(c.length > 400000 ? c.slice(0, 400000) + "\n\n… (truncated)" : c);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium" title={path}>
            {name}
          </span>
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close file"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-4 text-sm text-destructive">{error}</div>
        ) : content == null ? (
          <div className="p-4 text-sm text-muted-foreground">Loading…</div>
        ) : isMd ? (
          <div className="mx-auto max-w-3xl p-6">
            <MarkdownViewer content={content} />
          </div>
        ) : (
          <SyntaxHighlighter
            language={langFor(name)}
            style={dark ? oneDark : oneLight}
            showLineNumbers
            wrapLongLines={false}
            customStyle={{
              margin: 0,
              padding: "1rem",
              background: "transparent",
              fontSize: "12.5px",
              lineHeight: "1.6",
            }}
            codeTagProps={{
              style: { fontFamily: "var(--font-mono)", background: "transparent" },
            }}
          >
            {content}
          </SyntaxHighlighter>
        )}
      </div>
    </div>
  );
}
