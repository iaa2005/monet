/**
 * The words after a turn's Copy button: "23m 34s · 6.8 tok/s".
 *
 * Asked for with two examples — "2d 1h 34m" and "23m 34s" — and the rule
 * behind them is two or three units, never four. The speed is tokens over
 * the model's WRITING time, not the turn's: a local 27B reads an 11k prompt
 * for minutes and then writes at 7 a second, and a speed averaged over both
 * would say 1. Pure functions in chat/timing.ts, so this needs no browser.
 */

import { formatDuration, formatSpeed, formatTiming } from "../src/renderer/components/chat/timing";

let failures = 0;
const check = (name: string, got: unknown, want: unknown): void => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

check("under ten seconds keeps a decimal", formatDuration(400), "0.4s");
check("seconds", formatDuration(34_000), "34s");
check("minutes and seconds", formatDuration(23 * 60_000 + 34_000), "23m 34s");
check("hours drop the seconds", formatDuration(3_725_000), "1h 2m");
check("days keep hours and minutes", formatDuration(2 * 86_400_000 + 3_600_000 + 34 * 60_000), "2d 1h 34m");
check("a zero minute is still said", formatDuration(3_600_000), "1h 0m");
check("nonsense is nothing", formatDuration(-5), "");

check("speed is tokens over writing time", formatSpeed({ elapsedMs: 0, generationMs: 48_800, outputTokens: 333 }), "6.8 tok/s");
check("fast models lose the decimal", formatSpeed({ elapsedMs: 0, generationMs: 2_000, outputTokens: 250 }), "125 tok/s");
check("no writing time, no speed", formatSpeed({ elapsedMs: 0, generationMs: 0, outputTokens: 10 }), null);
check("no tokens, no speed", formatSpeed({ elapsedMs: 0, generationMs: 1_000, outputTokens: 0 }), null);

check("the line", formatTiming({ elapsedMs: 1_414_000, generationMs: 48_800, outputTokens: 333 }), "23m 34s · 6.8 tok/s");
check("time alone when the speed is unknown", formatTiming({ elapsedMs: 4_300, generationMs: 0, outputTokens: 0 }), "4.3s");
check("nothing for nothing", formatTiming(undefined), null);

console.log(failures ? `\n${failures} FAILED` : "\nALL TIMING CHECKS PASSED");
process.exit(failures ? 1 : 0);
