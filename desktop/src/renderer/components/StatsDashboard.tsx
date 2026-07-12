import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

interface Stats {
  sessions: number;
  messages: number;
  userMessages: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  peakHour: number | null;
  approxTokens: number;
  perDay: { date: string; count: number }[];
}

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

const RANGES = [
  { id: 0, label: "All" },
  { id: 30, label: "30d" },
  { id: 7, label: "7d" },
];

// ─── Literary milestones ───
// Each book has a personality — multiple hand-crafted messages so the
// comparison never feels templated.
interface Book {
  name: string;
  tokens: number;
  emoji: string;
  messages: string[];
}

const BOOKS: Book[] = [
  {
    name: "The Great Gatsby",
    tokens: 65_000,
    emoji: "🍸",
    messages: [
      "You've written enough to fill Gatsby's mansion with words.",
      "Fitzgerald took years; you did it in conversation.",
      "That's a whole lot of green lights and longing.",
    ],
  },
  {
    name: "Frankenstein",
    tokens: 100_000,
    emoji: "⚡",
    messages: [
      "Mary Shelley would be… intrigued.",
      "You've brought to life more text than Frankenstein's monster.",
      "It's alive! And it's your chat history.",
    ],
  },
  {
    name: "Harry Potter and the Philosopher's Stone",
    tokens: 102_000,
    emoji: "🪄",
    messages: [
      "You've outgrown Hogwarts — more tokens than the first Potter book.",
      "Wingardium Levio-saaa… that's a lot of words.",
      "Even Hermione would be impressed by this volume.",
    ],
  },
  {
    name: "Moby Dick",
    tokens: 275_000,
    emoji: "🐋",
    messages: [
      "Call me Ishmael. Actually, call me prolific.",
      "A white whale of a conversation — you've outpaced Melville.",
      "Thar she blows! And she's made of tokens.",
    ],
  },
  {
    name: "The Lord of the Rings (trilogy)",
    tokens: 640_000,
    emoji: "💍",
    messages: [
      "One does not simply… write 640K tokens. But you did.",
      "The entire journey from the Shire to Mordor, in chat form.",
      "You shall not pass! …without reading this much text.",
    ],
  },
  {
    name: "War and Peace",
    tokens: 780_000,
    emoji: "📖",
    messages: [
      "Tolstoy called. He wants his word count back.",
      "Peace was never an option. More tokens!",
      "Longer than War and Peace — and arguably more coherent.",
    ],
  },
  {
    name: "The Bible (KJV)",
    tokens: 1_040_000,
    emoji: "📜",
    messages: [
      "You've surpassed the Good Book itself.",
      "Genesis to Revelation, and then some.",
      "Let there be tokens. And there were tokens.",
    ],
  },
];

/** Pick a message for a book — stable per session, so it doesn't flicker. */
function bookMessage(book: Book, factor: number): string {
  const idx = Math.floor(factor * 37) % book.messages.length;
  return book.messages[idx];
}

/** Build the tamagotchi snapshot for a given token count. */
function tamagotchiSnapshot(tokens: number): {
  lines: { emoji: string; text: string }[];
} {
  if (tokens <= 0) {
    return {
      lines: [{ emoji: "🌱", text: "Every epic starts with a single token. Go write something!" }],
    };
  }

  const lines: { emoji: string; text: string }[] = [];
  let maxBook: Book | null = null;

  // Find the biggest book the user has surpassed (for the headline).
  for (const b of BOOKS) {
    if (tokens >= b.tokens) maxBook = b;
  }

  // Always show the biggest surpassed book with its unique message.
  if (maxBook) {
    const factor = tokens / maxBook.tokens;
    const mult = factor >= 2 ? `×${factor.toFixed(1)}` : "";
    lines.push({
      emoji: maxBook.emoji,
      text: `${bookMessage(maxBook, factor)} ${mult}`,
    });
  }

  // Show one more comparison at a different scale for texture.
  const smaller = [...BOOKS]
    .reverse()
    .find((b) => tokens >= b.tokens && b !== maxBook);
  if (smaller && smaller !== maxBook) {
    const factor = tokens / smaller.tokens;
    if (factor >= 1.3) {
      lines.push({
        emoji: smaller.emoji,
        text: `Also, that's ${factor.toFixed(1)}× ${smaller.name}. Just saying.`,
      });
    }
  }

  // Next milestone
  const next = BOOKS.find((b) => tokens < b.tokens);

  // For very large counts, show how many of a classic they've consumed.
  if (!lines[1] && tokens >= BOOKS[0].tokens * 2) {
    const n = Math.round(tokens / BOOKS[0].tokens);
    lines.push({
      emoji: "📚",
      text: `Stack ${n} Great Gatsbys — that's your library now.`,
    });
  }

  // If nothing matched (shouldn't happen with the zero guard above), at least
  // give a nod to the smallest book.
  if (lines.length === 0 && next) {
    const pct = Math.round((tokens / next.tokens) * 100);
    lines.push({
      emoji: next.emoji,
      text: `${pct}% of the way to ${next.name}. Keep going!`,
    });
  }

  return { lines };
}

const HEATMAP_COLS = 52;
const HEATMAP_ROWS = 7;

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtHour(h: number | null): string {
  if (h == null) return "—";
  const ap = h < 12 ? "AM" : "PM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh} ${ap}`;
}

/** Local YYYY-MM-DD — must match the backend's localDay() so counts line up. */
function localDayStr(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * GitHub-style grid: columns = weeks, rows = weekdays (Mon→Sun). The LAST
 * column is the current week, so today and recent activity always land inside
 * the window.
 */
function buildColumns(
  perDay: { date: string; count: number }[],
): { date: string; count: number; future: boolean }[][] {
  const counts = new Map(perDay.map((d) => [d.date, d.count]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = localDayStr(today);

  // Monday of the current week = start of the last column.
  const lastMonday = new Date(today);
  lastMonday.setDate(lastMonday.getDate() - ((lastMonday.getDay() + 6) % 7));
  const cursor = new Date(lastMonday);
  cursor.setDate(cursor.getDate() - (HEATMAP_COLS - 1) * 7);

  const columns: { date: string; count: number; future: boolean }[][] = [];
  for (let w = 0; w < HEATMAP_COLS; w++) {
    const col: { date: string; count: number; future: boolean }[] = [];
    for (let dow = 0; dow < HEATMAP_ROWS; dow++) {
      const ds = localDayStr(cursor);
      col.push({ date: ds, count: counts.get(ds) ?? 0, future: ds > todayStr });
      cursor.setDate(cursor.getDate() + 1);
    }
    columns.push(col);
  }
  return columns;
}

const SHOW_PAINTING = false; // set to true to reveal the full painting at 100% opacity

function cellStyle(
  count: number,
  max: number,
  future: boolean,
  pixelColor: string | null,
): React.CSSProperties {
  const color = pixelColor ?? "var(--sky-500)";
  if (SHOW_PAINTING) return { backgroundColor: color, opacity: 1 };
  if (future) return { background: "transparent" };
  const q = count <= 0 ? 0 : count / Math.max(1, max);
  const opacity = count <= 0 ? 0.06 : 0.25 + q * 0.75;
  return { backgroundColor: color, opacity };
}

function Heatmap({
  perDay,
  pixels,
}: {
  perDay: { date: string; count: number }[];
  pixels: string[] | null;
}): JSX.Element {
  const columns = buildColumns(perDay);
  const max = Math.max(1, ...perDay.map((d) => d.count));
  return (
    <div className="flex gap-1 w-full">
      {columns.map((col, ci) => (
        <div key={ci} className="flex flex-1 flex-col gap-1">
          {col.map((cell, dow) => {
            const color = pixels?.[dow * HEATMAP_COLS + ci] ?? null;
            return (
              <div
                key={cell.date}
                title={cell.future ? "" : `${cell.date}: ${cell.count} messages`}
                className="w-full rounded-[2px]"
                style={{
                  ...cellStyle(cell.count, max, cell.future, color),
                  aspectRatio: "1/3",
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function StatsDashboard(): JSX.Element {
  const [tab, setTab] = useState<"overview" | "models">("overview");
  const [range, setRange] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [model, setModel] = useState("—");
  const [paintingPixels, setPaintingPixels] = useState<string[] | null>(null);
  const [paintingTitle, setPaintingTitle] = useState<string | null>(null);

  // ── Load a random horizontal Monet painting & extract pixels ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          "https://raw.githubusercontent.com/iaa2005/monet-paintings/main/monet_paintings.json",
        );
        const data: { title: string; filename: string; aspect_ratio: number }[] =
          await res.json();
        const horizontals = data.filter((p) => p.aspect_ratio >= 1.67);
        if (horizontals.length === 0) return;
        const pick = horizontals[Math.floor(Math.random() * horizontals.length)];

        const img = new Image();
        img.crossOrigin = "anonymous";
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject();
          img.src = `https://raw.githubusercontent.com/iaa2005/monet-paintings/main/${pick.filename}`;
        });
        if (cancelled) return;

        // Resize + crop to HEATMAP_COLS × HEATMAP_ROWS
        const canvas = document.createElement("canvas");
        canvas.width = HEATMAP_COLS;
        canvas.height = HEATMAP_ROWS;
        const ctx = canvas.getContext("2d")!;
        const targetAspect = HEATMAP_COLS / HEATMAP_ROWS;
        const srcAspect = img.naturalWidth / img.naturalHeight;
        let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
        if (srcAspect > targetAspect) {
          sw = img.naturalHeight * targetAspect;
          sx = (img.naturalWidth - sw) / 2;
        } else {
          sh = img.naturalWidth / targetAspect;
          sy = (img.naturalHeight - sh) / 2;
        }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, HEATMAP_COLS, HEATMAP_ROWS);

        const pixels: string[] = [];
        for (let y = 0; y < HEATMAP_ROWS; y++) {
          for (let x = 0; x < HEATMAP_COLS; x++) {
            const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
            pixels.push(`rgb(${r},${g},${b})`);
          }
        }
        if (!cancelled) {
          setPaintingPixels(pixels);
          setPaintingTitle(pick.title);
        }
      } catch {
        // Fall back to default sky-blue colors.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    api()
      ?.stats.get(range || undefined)
      .then((s) => setStats(s as Stats))
      .catch(() => {});
  }, [range]);

  useEffect(() => {
    api()
      ?.providers.getActive()
      .then((p) => {
        const prov = p as { model?: string } | undefined;
        if (prov?.model) setModel(prov.model);
      })
      .catch(() => {});
  }, []);

  // Two rows, matching the official overview layout & order.
  const cards = stats
    ? [
        { label: "Sessions", value: fmtNum(stats.sessions) },
        { label: "Messages", value: fmtNum(stats.messages) },
        { label: "Total tokens", value: fmtNum(stats.approxTokens) },
        { label: "Active days", value: fmtNum(stats.activeDays) },
        { label: "Current streak", value: `${stats.currentStreak}d` },
        { label: "Longest streak", value: `${stats.longestStreak}d` },
        { label: "Peak hour", value: fmtHour(stats.peakHour) },
        { label: "Favorite model", value: model },
      ]
    : [];

  const tamagotchi = stats ? tamagotchiSnapshot(stats.approxTokens) : null;

  const recent = stats ? stats.perDay.slice(-30) : [];
  const maxDay = Math.max(1, ...recent.map((d) => d.count));

  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      <div className="rounded-2xl bg-black/[0.025] p-4 dark:bg-white/[0.04] border border-border">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex gap-1">
            {(["overview", "models"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-sm font-medium capitalize transition-colors",
                  tab === t
                    ? "bg-black/[0.06] text-foreground dark:bg-white/[0.1]"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex gap-0.5 rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.06]">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setRange(r.id)}
                className={cn(
                  "rounded-md px-2 py-0.5 text-xs transition-colors",
                  range === r.id
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {tab === "overview" ? (
          <>
            <div className="grid grid-cols-4 gap-2">
              {cards.map((c) => (
                <div
                  key={c.label}
                  className="rounded-md bg-black/[0.04] px-3 py-2.5 dark:bg-white/[0.06]"
                >
                  <div className="truncate text-xs text-muted-foreground">
                    {c.label}
                  </div>
                  <div
                    className="mt-1 truncate text-lg font-semibold leading-tight"
                    title={c.value}
                  >
                    {c.value}
                  </div>
                </div>
              ))}
            </div>

            {stats && tamagotchi && (
              <div className="mt-4">
                <Heatmap perDay={stats.perDay} pixels={paintingPixels} />
                {paintingTitle && (
                  <p className="mt-1 text-[10px] text-muted-foreground/50">
                    Activity painted with «{paintingTitle}» by Claude Monet
                  </p>
                )}
                {tamagotchi.lines.map((line, i) => (
                  <p
                    key={i}
                    className={cn(
                      "mt-2 text-xs",
                      i === 0
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    <span className="mr-1">{line.emoji}</span>
                    {line.text}
                  </p>
                ))}
              </div>
            )}
          </>
        ) : (
          <div>
            <div className="mb-3 text-sm font-medium">Activity by day</div>
            {recent.length > 0 ? (
              <div className="flex h-40 items-end gap-1">
                {recent.map((d) => (
                  <div
                    key={d.date}
                    className="flex h-full flex-1 items-end"
                    title={`${d.date}: ${d.count} messages`}
                  >
                    <div
                      className="w-full rounded-t bg-sky-500/70"
                      style={{
                        height: `${Math.max(3, (d.count / maxDay) * 100)}%`,
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-xs text-muted-foreground">
                No activity yet.
              </div>
            )}
            <p className="mt-3 text-[11px] text-muted-foreground">
              Active model: {model}. A per-model breakdown will appear once
              model usage is recorded per message.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
