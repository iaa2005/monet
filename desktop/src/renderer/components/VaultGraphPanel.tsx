/**
 * The vault graph — Obsidian's signature view, drawn by the app itself.
 *
 * A force layout on a 2D canvas, no graph library: repulsion between nodes
 * (spatial-grid approximated so a thousand notes stays interactive), springs
 * along wikilink edges, mild gravity to the centre. The simulation runs a
 * fixed budget of frames and coasts to a stop — a graph that never settles
 * is a screensaver, not a map.
 *
 * Reading the picture: node size is degree (hubs are big), colour is the
 * vault, orphans are dimmed — the same judgements wiki-lint makes, visible
 * at a glance. Hover names a note, click opens it in the viewer, Ctrl+click
 * in Obsidian, drag pans, wheel zooms to the cursor.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "@/components/icons/hg";
import { useIsDark } from "@/components/chat/highlight";
import { viewWorkspaceFile } from "@/components/artifact-actions";
import type { ElectronAPI, VaultGraph, VaultGraphNode } from "@/types/electron";
import { labelFor } from "@/lib/graph-labels";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

interface SimNode extends VaultGraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

/**
 * The brand's hue as a number, for the canvas.
 *
 * A canvas cannot use `hsl(var(--brand-hue) …)` — it wants a string it can
 * parse — so the one place the brand is written down is read out of the
 * stylesheet instead of copied. Copied is what it was: the first vault was
 * painted hue 18, which was the brand until the app turned blue, and then
 * it was just an orange graph nobody could explain.
 */
function brandHue(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(
    "--brand-hue",
  );
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 211;
}

/**
 * Distinct hues per vault; theme decides lightness.
 *
 * The first vault wears the brand — most people have one vault, and it
 * should look like it belongs to this app. The rest are spaced around the
 * wheel and deliberately far from it.
 */
function vaultHues(): number[] {
  return [brandHue(), 140, 280, 45, 330, 175];
}

const SIM_FRAMES = 240;

export function VaultGraphPanel({
  onTitle,
}: {
  /** Rename the dock tab once we know whose vault this is. */
  onTitle?: (title: string) => void;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [graph, setGraph] = useState<VaultGraph | null>(null);
  const [empty, setEmpty] = useState(false);
  const dark = useIsDark();

  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<{ a: number; b: number }[]>([]);
  const viewRef = useRef({ x: 0, y: 0, scale: 1 });
  const hoverRef = useRef<SimNode | null>(null);
  const framesRef = useRef(0);
  /** Extra simulation frames — dragging a node keeps the springs alive. */
  const hotRef = useRef(0);
  const dragNodeRef = useRef<SimNode | null>(null);
  const rafRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const g = await api()?.obsidian.graph();
    if (!g) return;
    setEmpty(g.nodes.length === 0);
    setGraph(g);
    // The tab wears the vault's name — "+N" when several are enabled.
    const names: string[] = [];
    for (const n of g.nodes)
      if (!names.includes(n.vaultName)) names.push(n.vaultName);
    if (names.length > 0)
      onTitle?.(names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`);
  }, [onTitle]);
  useEffect(() => {
    void load();
  }, [load]);

  // ── Seed the simulation whenever the data changes ──────────────────────
  useEffect(() => {
    if (!graph) return;
    const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
    // Deterministic spiral seeding: stable layouts across refreshes beat
    // random ones you can never find your way around twice.
    nodesRef.current = graph.nodes.map((n, i) => {
      const angle = i * 2.39996; // golden angle
      const rad = 24 * Math.sqrt(i);
      return {
        ...n,
        x: Math.cos(angle) * rad,
        y: Math.sin(angle) * rad,
        vx: 0,
        vy: 0,
        // Obsidian-sized: small dots, hubs only modestly bigger — the graph
        // reads by SHAPE, not by circles shouting.
        r: 3 + Math.min(5.5, Math.sqrt(n.links) * 1.05),
      };
    });
    edgesRef.current = graph.edges
      .map((e) => ({ a: index.get(e.from) ?? -1, b: index.get(e.to) ?? -1 }))
      .filter((e) => e.a >= 0 && e.b >= 0);
    viewRef.current = { x: 0, y: 0, scale: 1 };
    framesRef.current = 0;
  }, [graph]);

  // ── Simulate + draw ────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const step = (): void => {
      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      const simulating =
        (framesRef.current < SIM_FRAMES || hotRef.current > 0) && nodes.length > 0;
      if (simulating) {
        framesRef.current++;
        if (hotRef.current > 0) hotRef.current--;
        // Repulsion via a coarse grid: only neighbouring cells push, which
        // is what keeps a big vault from freezing the panel.
        const CELL = 90;
        const grid = new Map<string, number[]>();
        nodes.forEach((n, i) => {
          const k = `${Math.floor(n.x / CELL)}:${Math.floor(n.y / CELL)}`;
          const cell = grid.get(k);
          if (cell) cell.push(i);
          else grid.set(k, [i]);
        });
        nodes.forEach((n, i) => {
          const cx = Math.floor(n.x / CELL);
          const cy = Math.floor(n.y / CELL);
          for (let gx = cx - 1; gx <= cx + 1; gx++)
            for (let gy = cy - 1; gy <= cy + 1; gy++)
              for (const j of grid.get(`${gx}:${gy}`) ?? []) {
                if (j <= i) continue;
                const m = nodes[j];
                let dx = n.x - m.x;
                let dy = n.y - m.y;
                const d2 = dx * dx + dy * dy || 1;
                if (d2 > CELL * CELL) continue;
                const f = 900 / d2;
                const d = Math.sqrt(d2);
                dx /= d;
                dy /= d;
                n.vx += dx * f;
                n.vy += dy * f;
                m.vx -= dx * f;
                m.vy -= dy * f;
              }
        });
        for (const e of edges) {
          const a = nodes[e.a];
          const b = nodes[e.b];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const f = (d - 70) * 0.01;
          a.vx += (dx / d) * f;
          a.vy += (dy / d) * f;
          b.vx -= (dx / d) * f;
          b.vy -= (dy / d) * f;
        }
        for (const n of nodes) {
          n.vx -= n.x * 0.0008; // gravity
          n.vy -= n.y * 0.0008;
          n.vx *= 0.85;
          n.vy *= 0.85;
          n.x += n.vx;
          n.y += n.vy;
        }
        // The dragged node goes where the hand says — after integration, so
        // the springs feel it pull and the neighbourhood swings along.
        const held = dragNodeRef.current;
        if (held) {
          held.vx = 0;
          held.vy = 0;
        }
      }

      // Draw.
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const view = viewRef.current;
      ctx.save();
      ctx.translate(w / 2 + view.x, h / 2 + view.y);
      ctx.scale(view.scale, view.scale);

      const ink = dark ? "255,255,255" : "0,0,0";
      // Hover focuses the neighbourhood, the Obsidian way: the hovered
      // note's edges light up in the accent, its neighbours stay solid, and
      // everything unrelated fades back.
      const focus = hoverRef.current;
      const near = new Set<number>();
      if (focus) {
        nodesRef.current.forEach((n, i) => {
          if (n.id === focus.id) near.add(i);
        });
        for (const e of edgesRef.current) {
          const a = nodesRef.current[e.a];
          const b = nodesRef.current[e.b];
          if (a.id === focus.id) near.add(e.b);
          if (b.id === focus.id) near.add(e.a);
        }
      }

      ctx.lineWidth = 1 / view.scale;
      ctx.strokeStyle = `rgba(${ink},${focus ? 0.05 : 0.13})`;
      ctx.beginPath();
      for (const e of edgesRef.current) {
        const a = nodesRef.current[e.a];
        const b = nodesRef.current[e.b];
        if (focus && (a.id === focus.id || b.id === focus.id)) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      if (focus) {
        ctx.lineWidth = 1.4 / view.scale;
        ctx.strokeStyle = `hsl(${brandHue()} 70% ${dark ? 65 : 55}%)`;
        ctx.beginPath();
        for (const e of edgesRef.current) {
          const a = nodesRef.current[e.a];
          const b = nodesRef.current[e.b];
          if (a.id !== focus.id && b.id !== focus.id) continue;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
      }

      // Zooming IN must not inflate the dots — you zoom to read, not to
      // meet giant circles. On screen a node keeps (almost) its size while
      // labels grow with the zoom; zooming OUT still shrinks dots normally.
      const zoomK =
        view.scale <= 1 ? 1 : Math.pow(view.scale, 0.28) / view.scale;
      const worldR = (r: number): number => r * zoomK;
      const fontPx =
        (9.5 * Math.sqrt(Math.max(1, view.scale))) / view.scale;

      const hues = vaultHues();
      const vaultHue = new Map<string, number>();
      nodesRef.current.forEach((n, i) => {
        if (!vaultHue.has(n.vaultName))
          vaultHue.set(n.vaultName, hues[vaultHue.size % hues.length]);
        const hue = vaultHue.get(n.vaultName) ?? hues[0];
        const orphan = n.links === 0;
        const hover = focus?.id === n.id;
        const dimmed = focus != null && !near.has(i);
        ctx.beginPath();
        ctx.arc(n.x, n.y, worldR(n.r) + (hover ? 1.5 / view.scale : 0), 0, Math.PI * 2);
        // Dots are NEVER translucent (edges may fade, nodes may not): a
        // dimmed or orphan note is a solid grey, exactly as Obsidian draws
        // it — transparency reads as a rendering glitch, grey reads as
        // "not the subject right now".
        ctx.fillStyle = hover
          ? `hsl(${brandHue()} 70% ${dark ? 68 : 55}%)`
          : dimmed
            ? dark
              ? "hsl(0 0% 26%)"
              : "hsl(0 0% 84%)"
            : orphan
              ? dark
                ? "hsl(0 0% 42%)"
                : "hsl(0 0% 68%)"
              : `hsl(${hue} ${dark ? 65 : 70}% ${dark ? 62 : 45}%)`;
        ctx.fill();
        // Labels appear as you zoom in — all at once they are noise — and
        // dissolve as you zoom out, before they can pile onto each other.
        // The rule lives in lib/graph-labels.ts, where a probe can hold it.
        const label = labelFor({
          scale: view.scale,
          radius: n.r,
          hover,
          focused: focus != null,
          inNeighbourhood: near.has(i),
        });
        if (label.show && !dimmed) {
          ctx.fillStyle = `rgba(${ink},${label.alpha})`;
          ctx.font = `${fontPx}px system-ui`;
          ctx.fillText(
            n.name,
            n.x + worldR(n.r) + 3 / view.scale,
            n.y + 3 / view.scale,
          );
        }
      });
      ctx.restore();
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [dark, graph]);

  // ── Interaction ────────────────────────────────────────────────────────
  const toWorld = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const view = viewRef.current;
    return {
      x: (e.clientX - rect.left - rect.width / 2 - view.x) / view.scale,
      y: (e.clientY - rect.top - rect.height / 2 - view.y) / view.scale,
    };
  };
  const nodeAt = (wx: number, wy: number): SimNode | null => {
    // The hit target matches what is DRAWN: node radii compress as you zoom
    // in (see the draw loop), so the hit radius must compress the same way.
    const scale = viewRef.current.scale;
    const zoomK = scale <= 1 ? 1 : Math.pow(scale, 0.28) / scale;
    let best: SimNode | null = null;
    let bestD = Infinity;
    for (const n of nodesRef.current) {
      const d = (n.x - wx) ** 2 + (n.y - wy) ** 2;
      const hit = (n.r * zoomK + 6 / scale) ** 2;
      if (d < hit && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  };

  const dragRef = useRef<{ x: number; y: number } | null>(null);

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        className="h-full w-full cursor-grab active:cursor-grabbing"
        onMouseDown={(e) => {
          const w = toWorld(e);
          const n = nodeAt(w.x, w.y);
          if (n) {
            // Grab the NODE: it follows the hand and the springs follow it.
            dragNodeRef.current = n;
            hotRef.current = 60;
          } else {
            dragRef.current = { x: e.clientX, y: e.clientY };
          }
        }}
        onMouseMove={(e) => {
          const held = dragNodeRef.current;
          if (held && e.buttons === 1) {
            const w = toWorld(e);
            held.x = w.x;
            held.y = w.y;
            hotRef.current = 60; // keep the springs simulating while we pull
            return;
          }
          if (dragRef.current && e.buttons === 1) {
            viewRef.current.x += e.clientX - dragRef.current.x;
            viewRef.current.y += e.clientY - dragRef.current.y;
            dragRef.current = { x: e.clientX, y: e.clientY };
            return;
          }
          const w = toWorld(e);
          hoverRef.current = nodeAt(w.x, w.y);
        }}
        onMouseUp={() => {
          // Single click selects nothing and opens nothing — hover already
          // lights the neighbourhood, and opening lives on double click.
          dragNodeRef.current = null;
          dragRef.current = null;
        }}
        onDoubleClick={(e) => {
          const w = toWorld(e);
          const n = nodeAt(w.x, w.y);
          if (!n) return;
          if (e.ctrlKey || e.metaKey) void api()?.obsidian.openInApp(n.path);
          else
            viewWorkspaceFile({
              name: n.relPath.split("/").pop() ?? n.name,
              path: n.path,
              mediaType: "text/markdown",
              kind: "file",
            });
        }}
        onWheel={(e) => {
          const view = viewRef.current;
          const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
          const next = Math.min(4, Math.max(0.15, view.scale * factor));
          // Zoom toward the cursor: the point under it stays under it.
          const rect = canvasRef.current!.getBoundingClientRect();
          const px = e.clientX - rect.left - rect.width / 2;
          const py = e.clientY - rect.top - rect.height / 2;
          view.x = px - ((px - view.x) / view.scale) * next;
          view.y = py - ((py - view.y) / view.scale) * next;
          view.scale = next;
        }}
      />
      <div className="absolute left-2 top-2 flex items-center gap-2">
        <button
          type="button"
          title="Rebuild the graph from disk"
          onClick={() => void load()}
          className="flex size-7 items-center justify-center rounded-md border border-border bg-card/80 text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
        >
          <RefreshCw className="size-3.5" />
        </button>
        {graph && !empty && (
          <span className="rounded-md border border-border bg-card/80 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur">
            {graph.nodes.length} notes · {graph.edges.length} links — drag to
            arrange, double-click opens, Ctrl+double-click in Obsidian
          </span>
        )}
        {/* Several vaults draw in several colours — name them. The legend
            derives hues exactly the way the draw loop does: order of first
            appearance in the node list. */}
        {graph &&
          (() => {
            const names: string[] = [];
            for (const n of graph.nodes)
              if (!names.includes(n.vaultName)) names.push(n.vaultName);
            if (names.length < 2) return null;
            return names.map((name, i) => (
              <span
                key={name}
                className="flex items-center gap-1 rounded-md border border-border bg-card/80 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur"
              >
                <span
                  className="size-2 rounded-full"
                  style={{
                    backgroundColor: `hsl(${vaultHues()[i % vaultHues().length]} ${dark ? 65 : 70}% ${dark ? 62 : 45}%)`,
                  }}
                />
                {name}
              </span>
            ));
          })()}
      </div>
      {empty && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
          No notes to draw — enable a vault in Settings → Obsidian.
        </div>
      )}
    </div>
  );
}
