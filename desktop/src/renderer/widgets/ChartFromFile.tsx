/**
 * A chart whose numbers come from a file, not from the answer.
 *
 * Inlining the data was the first design and it does not scale: 161 hourly
 * candles is ~4000 output tokens the model spends RETYPING numbers it already
 * has, and every one of them is a chance to mistype a price. The data came
 * from RunPython; it should stay there.
 *
 *   ```chart
 *   { "type": "candlestick", "title": "TSLA", "src": "tsla.json" }
 *   ```
 *
 * `src` names a file in this chat's sandbox — the same place RunPython writes
 * and Read reads. Whatever it holds is merged UNDER the block, so the block
 * still says what kind of chart it is and the file only carries rows.
 *
 * The sandbox is the only place it looks. A chart must not become a way to
 * read an arbitrary path: the name is matched against this session's own file
 * listing, and anything not in it simply is not found.
 */

import { useEffect, useState } from "react";
import { useChatStore } from "@/stores/chatStore";
import { useSessionArtifacts } from "@/lib/sessionArtifacts";
import { Chart, type ChartSpec } from "./Chart";

interface Api {
  sandbox?: {
    readText?: (
      sessionId: string | undefined,
      name: string,
    ) => Promise<{ ok: boolean; content?: string; error?: string }>;
    listFiles?: (
      sessionId?: string,
    ) => Promise<{ name: string; path: string }[]>;
  };
  artifacts?: {
    readText?: (
      path: string,
    ) => Promise<{ ok: boolean; content?: string; error?: string }>;
  };
}

const api = (): Api | undefined =>
  (window as unknown as { electronAPI?: Api }).electronAPI;

export function ChartFromFile({
  spec,
  asOf,
}: {
  spec: ChartSpec;
  /**
   * When the message holding this block was written.
   *
   * Without it a chart reads whatever the file says NOW, so the model writing
   * a second tsla.json silently rewrites every chart earlier in the chat — the
   * transcript stops being a record of what was answered. Artifacts are stored
   * one file per write ("<ts>-tsla.json", which is what the version chip in
   * the Artifacts panel lists), so the version that existed at `asOf` is still
   * on disk. This picks that one.
   */
  asOf?: number;
}): JSX.Element {
  const sessionId = useChatStore((s) => s.currentSessionId);
  const artifacts = useSessionArtifacts();
  const [loaded, setLoaded] = useState<ChartSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const src = spec.src;

  useEffect(() => {
    let alive = true;
    setLoaded(null);
    setError(null);
    void (async () => {
      try {
        const sandbox = api()?.sandbox;
        const base = (p: string): string => p.split(/[\\/]/).pop() ?? p;
        const want = base(src ?? "");
        // The copy that existed when this message was written. Artifacts are
        // stored one file per write ("<ts>-tsla.json" — the same copies the
        // version chip lists), so "newest at or before asOf" is exactly the
        // version this answer was drawn from.
        const snapshot = asOf
          ? artifacts.output
              .filter((a) => base(a.name) === want && a.ts <= asOf && a.path)
              .sort((x, y) => y.ts - x.ts)[0]
          : undefined;
        let r = snapshot?.path
          ? await api()?.artifacts?.readText?.(snapshot.path)
          : undefined;
        // No snapshot — a file the model wrote outside a tool result, or a
        // chart from before this chat recorded one. Fall back to live.
        if (!r?.ok)
          r = await sandbox?.readText?.(sessionId ?? undefined, src ?? "");
        if (!r?.ok) {
          // A model that wrote "out/tsla.json" in Python and "tsla.json" in
          // the block meant the same file.
          const files = await sandbox?.listFiles?.(sessionId ?? undefined);
          const hit = files?.find((f) => base(f.name) === want);
          if (hit) r = await sandbox?.readText?.(sessionId ?? undefined, hit.name);
        }
        if (!r?.ok || !r.content) {
          if (alive) setError(r?.error ?? `could not read ${src}`);
          return;
        }
        const data: unknown = JSON.parse(r.content);
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          if (alive) setError("the file is not a JSON object");
          return;
        }
        // The block wins: it declares the chart, the file supplies the rows.
        if (alive) setLoaded({ ...(data as ChartSpec), ...spec });
      } catch (err) {
        if (alive)
          setError(err instanceof Error ? err.message : "could not load the data");
      }
    })();
    return () => {
      alive = false;
    };
  }, [src, sessionId, spec, asOf, artifacts]);

  if (error)
    return (
      <div className="my-3 rounded-xl border border-border bg-card px-3 py-4 text-[13px] text-muted-foreground">
        Chart data: {error}.
      </div>
    );
  if (!loaded)
    return (
      <div className="my-3 h-[120px] animate-pulse rounded-xl border border-border bg-muted/30" />
    );
  return <Chart spec={loaded} />;
}
