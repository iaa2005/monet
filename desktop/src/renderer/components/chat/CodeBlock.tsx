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

export function CodeBlock({
  code,
  language = "",
  bare = false,
  showLineNumbers = false,
  className,
  maxHeight,
}: CodeBlockProps): JSX.Element {
  const dark = useIsDark();
  const lang = language.toLowerCase();
  const displayLang = PLAIN.has(lang) ? "" : lang;

  return (
    <div
      className={cn(
        "my-3 overflow-hidden rounded-lg border border-border bg-card",
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
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
