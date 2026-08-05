/**
 * Settings → Editor — pick the code-highlighting palette, see it at once.
 *
 * Light and dark are chosen separately (a dark palette on a light panel is
 * an accident, not a theme); the app's own light/dark toggle decides which
 * one is live. Each swatch shows the palette's five most telling colours;
 * clicking writes ten CSS variables (lib/code-theme.ts), which recolours
 * every code surface on screen — including the preview below — with no
 * reload and no re-render.
 */

import { useState } from "react";
import { CodeBlock } from "@/components/chat/CodeBlock";
import { useIsDark } from "@/components/chat/highlight";
import {
  CODE_THEMES,
  currentThemeId,
  setCodeTheme,
  themesFor,
  type CodePalette,
} from "@/lib/code-theme";
import { cn } from "@/lib/utils";

/** Deliberately dense: comments, keywords, classes, numbers, strings with
 * interpolation, regex, JSX tags and attributes, operators — one glance
 * covers every slot a palette defines. */
const SAMPLE = `/** Where the paint goes: every token kind in one screen. */
import { useMemo, type ReactNode } from "react";

const LIMIT = 0x2a; // 42, but dressed up
const GREETING = \`Bonjour, \${new Date().getFullYear()}!\`;

export class PaletteDemo<T extends { id: string }> {
  private seen = new Map<string, T>();

  constructor(readonly items: T[] = []) {}

  *matching(pattern: RegExp = /^mo(net|nokai)$/i): Generator<T> {
    for (const item of this.items) {
      if (!pattern.test(item.id) || this.seen.has(item.id)) continue;
      this.seen.set(item.id, item);
      yield item;
    }
  }
}

export function Swatch({ active = false }: { active?: boolean }): ReactNode {
  const label = useMemo(() => GREETING.toUpperCase(), []);
  return (
    <button className={active ? "ring-2" : "opacity-70"} disabled={!active}>
      {label} — {LIMIT * 2 + 0.5}
    </button>
  );
}`;

function SwatchDots({ theme }: { theme: CodePalette }): JSX.Element {
  const dots = [
    theme.colors.keyword,
    theme.colors.string,
    theme.colors.func,
    theme.colors.tag,
    theme.colors.const,
  ];
  return (
    <span className="flex items-center gap-1">
      {dots.map((c, i) => (
        <span
          key={i}
          className="size-2.5 rounded-full"
          style={{ backgroundColor: c }}
        />
      ))}
    </span>
  );
}

function ThemeGrid({
  mode,
  chosen,
  onPick,
}: {
  mode: "light" | "dark";
  chosen: string;
  onPick: (id: string) => void;
}): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      {themesFor(mode).map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onPick(t.id)}
          className={cn(
            "flex items-center justify-between rounded-lg border px-2.5 py-2 text-left text-xs transition-colors",
            chosen === t.id
              ? "border-brand bg-brand/10 font-medium"
              : "border-border hover:bg-black/[0.04] dark:hover:bg-white/[0.05]",
          )}
        >
          <span className="truncate pr-2">{t.label}</span>
          <SwatchDots theme={t} />
        </button>
      ))}
    </div>
  );
}

export function EditorSettings(): JSX.Element {
  const dark = useIsDark();
  const [light, setLight] = useState(() => currentThemeId("light"));
  const [darkId, setDarkId] = useState(() => currentThemeId("dark"));

  const pick = (mode: "light" | "dark", id: string): void => {
    setCodeTheme(mode, id);
    if (mode === "light") setLight(id);
    else setDarkId(id);
  };

  const liveLabel =
    CODE_THEMES.find((t) => t.id === (dark ? darkId : light))?.label ?? "";

  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-base font-semibold">Editor</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Syntax highlighting for code everywhere it appears — chat blocks,
          diffs, notebooks and the file editor. Light and dark are separate
          choices; the app&apos;s theme toggle decides which one you see.
        </p>
      </section>

      <section>
        <h4 className={cn("mb-1.5 text-sm font-medium", !dark && "text-brand")}>
          Light code theme{!dark && " · active now"}
        </h4>
        <ThemeGrid mode="light" chosen={light} onPick={(id) => pick("light", id)} />
      </section>

      <section>
        <h4 className={cn("mb-1.5 text-sm font-medium", dark && "text-brand")}>
          Dark code theme{dark && " · active now"}
        </h4>
        <ThemeGrid mode="dark" chosen={darkId} onPick={(id) => pick("dark", id)} />
      </section>

      <section>
        <h4 className="mb-1.5 text-sm font-medium">
          Preview — {liveLabel}
        </h4>
        <CodeBlock code={SAMPLE} language="tsx" maxHeight={420} />
      </section>
    </div>
  );
}
