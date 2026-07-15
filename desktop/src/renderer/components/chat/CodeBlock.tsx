/**
 * Code block — syntax-highlighted fenced code with a header bar (language +
 * copy), matching the official Claude Code rendering. Used by MarkdownViewer
 * for fenced blocks and by ToolCallBubble for tool output.
 */

import { useEffect, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  oneLight,
  oneDark,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/** Reactively tracks the `dark` class on <html> so highlighting follows theme. */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined"
      ? document.documentElement.classList.contains("dark")
      : false,
  );
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() =>
      setDark(el.classList.contains("dark")),
    );
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

// Fenced-block languages that don't need a "language:" label chip.
const PLAIN = new Set(["", "text", "plaintext", "txt", "output"]);

function CopyButton({ text }: { text: string }): JSX.Element {
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
      title="Copy code"
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

export interface CodeBlockProps {
  code: string;
  language?: string;
  /** Hide the header bar (used where the container already provides chrome). */
  bare?: boolean;
  showLineNumbers?: boolean;
  className?: string;
  maxHeight?: number | string;
}

// Big tool outputs (e.g. ReadFile on a large file) froze the UI: Prism
// tokenizes the ENTIRE string and produces a huge DOM. Show a preview and
// expand on demand; past a hard cap, skip highlighting altogether.
const PREVIEW_LINES = 300;
const HIGHLIGHT_CHAR_LIMIT = 60_000;

export function CodeBlock({
  code,
  language = "",
  bare = false,
  showLineNumbers = false,
  className,
  maxHeight,
}: CodeBlockProps): JSX.Element {
  const dark = useIsDark();
  const [expanded, setExpanded] = useState(false);
  const lang = language.toLowerCase();
  const displayLang = PLAIN.has(lang) ? "" : lang;

  const lines = code.split("\n");
  // Small hysteresis so we never truncate for a measly few lines.
  const truncatable = lines.length > PREVIEW_LINES + 60;
  const shown =
    truncatable && !expanded
      ? lines.slice(0, PREVIEW_LINES).join("\n")
      : code;
  const plain = shown.length > HIGHLIGHT_CHAR_LIMIT;

  return (
    <div
      className={cn(
              "glass-panel my-3 overflow-hidden rounded-lg border border-border bg-card",
        className,
      )}
    >
      {!bare && (
        <div className="flex h-8 items-center justify-between border-b border-border bg-muted/50 pr-1 pl-3">
          <span className="font-mono text-[11px] text-muted-foreground">
            {displayLang}
          </span>
          <CopyButton text={code} />
        </div>
      )}
      <div className="overflow-auto" style={maxHeight ? { maxHeight } : undefined}>
        {plain ? (
          <pre
            className="m-0 whitespace-pre p-3"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "12.5px",
              lineHeight: "1.6",
            }}
          >
            {shown}
          </pre>
        ) : (
          <SyntaxHighlighter
            language={displayLang || "text"}
            style={dark ? oneDark : oneLight}
            showLineNumbers={showLineNumbers}
            wrapLongLines={false}
            customStyle={{
              margin: 0,
              padding: "0.75rem",
              background: "transparent",
              fontSize: "12.5px",
              lineHeight: "1.6",
            }}
            codeTagProps={{
              style: {
                fontFamily: "var(--font-mono)",
                background: "transparent",
              },
            }}
          >
            {shown}
          </SyntaxHighlighter>
        )}
      </div>
      {truncatable && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="block w-full border-t border-border bg-muted/40 px-3 py-1.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded
            ? "Collapse"
            : `Show ${lines.length - PREVIEW_LINES} more lines`}
        </button>
      )}
    </div>
  );
}
