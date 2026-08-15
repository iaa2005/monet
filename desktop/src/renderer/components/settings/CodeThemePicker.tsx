/**
 * The code-theme picker: two grids and a live sample.
 *
 * Extracted from Settings → Editor because first-run setup offers the same
 * choice, and offering it with a second, smaller widget would mean choosing
 * a palette you cannot see. Same grids, same swatches, same preview, one
 * implementation.
 *
 * Light and dark are chosen separately (a dark palette on a light panel is
 * an accident, not a theme); the app's own light/dark toggle decides which
 * one is live. Each swatch shows the palette's five most telling colours;
 * clicking writes ten CSS variables (lib/code-theme.ts), which recolours
 * every code surface on screen — including the preview — with no reload and
 * no re-render.
 */

import { useEffect, useState } from "react";
import { Moon, Sun } from "@/components/icons/hg";
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

export function CodeThemePicker(): JSX.Element {
  const dark = useIsDark();
  const [light, setLight] = useState(() => currentThemeId("light"));
  const [darkId, setDarkId] = useState(() => currentThemeId("dark"));
  // What the PREVIEW wears — follows the app until the user flips it, and
  // follows a click in either grid, so what you just picked is what you see.
  const [previewMode, setPreviewMode] = useState<"light" | "dark">(
    dark ? "dark" : "light",
  );
  useEffect(() => setPreviewMode(dark ? "dark" : "light"), [dark]);

  const pick = (mode: "light" | "dark", id: string): void => {
    setCodeTheme(mode, id);
    if (mode === "light") setLight(id);
    else setDarkId(id);
    setPreviewMode(mode);
  };

  const previewLabel =
    CODE_THEMES.find(
      (t) => t.id === (previewMode === "dark" ? darkId : light),
    )?.label ?? "";

  return (
    <div className="space-y-5">
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
        <div className="mb-1.5 flex items-center justify-between">
          <h4 className="text-sm font-medium">Preview — {previewLabel}</h4>
          {/* Try either palette without touching the app's own theme. */}
          <div className="inline-flex overflow-hidden rounded-md border border-border">
            {(
              [
                ["light", Sun],
                ["dark", Moon],
              ] as const
            ).map(([mode, Icon]) => (
              <button
                key={mode}
                type="button"
                title={`Preview the ${mode} theme`}
                onClick={() => setPreviewMode(mode)}
                className={cn(
                  "flex size-6 items-center justify-center transition-colors",
                  previewMode === mode
                    ? "bg-brand/15 text-brand"
                    : "text-muted-foreground hover:bg-black/[0.05] dark:hover:bg-white/[0.06]",
                )}
              >
                <Icon className="size-3.5" />
              </button>
            ))}
          </div>
        </div>
        {/* Full height, no inner scroll: the sample IS the panel. The wrapper
            pins the subtree's palette and surface to previewMode, whatever
            mode the app itself is in. */}
        <div
          className={cn(
            "overflow-hidden rounded-lg border border-border",
            previewMode === "dark" ? "code-preview-dark" : "code-preview-light",
          )}
        >
          <CodeBlock
            code={SAMPLE}
            language="tsx"
            bare
            className="my-0 rounded-none border-0 bg-transparent"
          />
        </div>
      </section>
    </div>
  );
}
