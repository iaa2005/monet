/**
 * Does a coordinate survive the trip to the input layer?
 *
 * The bug: the DIP→physical conversion is Windows-only, and when it was
 * written inline the macOS side simply had no assignment — every click went
 * to [0, 0] and parked the pointer in the corner of the screen. A
 * pass-through is easy to omit when it is spelled as "do nothing", so it is
 * spelled as a function and checked here.
 */

import { fromInputPoint, toInputPoint } from "../src/main/computer/screen.js";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const cases = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
  { x: 300, y: 300 },
  { x: 1439, y: 899 },
  { x: 2560, y: 1440 },
];

for (const c of cases) {
  const out = toInputPoint(c);
  check(
    `toInputPoint keeps [${c.x}, ${c.y}]`,
    out.x === c.x && out.y === c.y,
    JSON.stringify(out),
  );
}
for (const c of cases) {
  const out = fromInputPoint(c);
  check(
    `fromInputPoint keeps [${c.x}, ${c.y}]`,
    out.x === c.x && out.y === c.y,
    JSON.stringify(out),
  );
}

// The failure that shipped: a non-zero point arriving as the origin.
const moved = toInputPoint({ x: 742, y: 415 });
check(
  "a real click never collapses to the corner",
  !(moved.x === 0 && moved.y === 0),
  JSON.stringify(moved),
);

console.log(failures === 0 ? "\ninput point: PASS" : `\ninput point: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
