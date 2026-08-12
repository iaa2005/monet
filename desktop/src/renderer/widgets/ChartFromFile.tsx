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
}

const api = (): Api | undefined =>
  (window as unknown as { electronAPI?: Api }).electronAPI;

export function ChartFromFile({ spec }: { spec: ChartSpec }): JSX.Element {
  const sessionId = useChatStore((s) => s.currentSessionId);
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
        let r = await sandbox?.readText?.(sessionId ?? undefined, src ?? "");
        if (!r?.ok) {
          // The name as written did not resolve. A model that wrote
          // "out/tsla.json" in Python and "tsla.json" in the block meant the
          // same file, so try to find it by basename before giving up.
          const base = (p: string): string => p.split(/[\\/]/).pop() ?? p;
          const files = await sandbox?.listFiles?.(sessionId ?? undefined);
          const hit = files?.find((f) => base(f.name) === base(src ?? ""));
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
  }, [src, sessionId, spec]);

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
