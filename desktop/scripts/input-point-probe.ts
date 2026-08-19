/**
 * Does a coordinate survive the trip to the input layer?
 *
 * The bug: the DIP→physical conversion is Windows-only, and when it was
 * written inline the macOS side simply had no assignment — every click went
 * to [0, 0] and parked the pointer in the corner of the screen. A
 * pass-through is easy to omit when it is spelled as "do nothing", so it is
 * spelled as a function and checked here.
 *
 * The check itself has two shapes, because the correct answer does:
 * everywhere but Windows the point must come out UNCHANGED, and on Windows it
 * must come out CONVERTED — identical only on a 100% display, and a round trip
 * away from the original on any other. Asserted as identity everywhere, this
 * probe would demand that Windows be broken. (It did, and it never ran here:
 * the stub had no dipToScreenPoint, so the Windows branch threw on the first
 * call — the platform's own half went untested until it was run on it.)
 */

import { fromInputPoint, toInputPoint } from "../src/main/computer/screen.js";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const WIN = process.platform === "win32";
const scale = Number(process.env.SMOKE_SCALE_FACTOR || 1);

const cases = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
  { x: 300, y: 300 },
  { x: 1439, y: 899 },
  { x: 2560, y: 1440 },
];

for (const c of cases) {
  const out = toInputPoint(c);
  if (WIN)
    check(
      `toInputPoint scales [${c.x}, ${c.y}] for the input layer`,
      out.x === Math.round(c.x * scale) && out.y === Math.round(c.y * scale),
      JSON.stringify(out),
    );
  else
    check(
      `toInputPoint keeps [${c.x}, ${c.y}]`,
      out.x === c.x && out.y === c.y,
      JSON.stringify(out),
    );
}

for (const c of cases) {
  const out = fromInputPoint(c);
  if (WIN)
    check(
      `fromInputPoint brings [${c.x}, ${c.y}] back to DIP`,
      out.x === c.x / scale && out.y === c.y / scale,
      JSON.stringify(out),
    );
  else
    check(
      `fromInputPoint keeps [${c.x}, ${c.y}]`,
      out.x === c.x && out.y === c.y,
      JSON.stringify(out),
    );
}

// The pair is one thing: what the tool sends must be what the tool reads back.
for (const c of cases) {
  const round = fromInputPoint(toInputPoint(c));
  check(
    `[${c.x}, ${c.y}] survives the round trip`,
    Math.abs(round.x - c.x) <= 1 && Math.abs(round.y - c.y) <= 1,
    JSON.stringify(round),
  );
}

// The failure that shipped: a real point arriving as the origin.
const moved = toInputPoint({ x: 742, y: 415 });
check(
  "a real click never collapses to the corner",
  !(moved.x === 0 && moved.y === 0),
  JSON.stringify(moved),
);

console.log(failures === 0 ? "\ninput point: PASS" : `\ninput point: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
