/**
 * End-to-end check of the memory pipeline (daily log → consolidation → index →
 * prompt injection), run under plain Node with the electron stub.
 *
 * MUST be run with a cwd that contains a monet-bootstrap.json pointing dataDir
 * at a throwaway folder: the stub's app.getPath() returns process.cwd(), so
 * without that this writes into the user's REAL memory directory.
 */

import { existsSync, readFileSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../src/main/data-dir.js";
import { appendDailyLog, dailyLogPath, pendingBulletCount, readLogsSince } from "../src/main/memory/daily-log.js";
import {
  buildMemoryPrompt,
  getMemoryDir,
  indexPath,
  readMemoryIndex,
  writeMemoryFile,
  writeMemoryIndex,
} from "../src/main/memory/store.js";
import { getConsolidationState, runConsolidation } from "../src/main/memory/consolidate.js";
import { _shouldRunNow } from "../src/main/memory/nightly.js";

let failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failed++;
};

// ── Guard: refuse to run against a real data dir ────────────────────────────
const dataDir = getDataDir();
if (!/probe|tmp|temp/i.test(dataDir)) {
  console.error(`REFUSING: data dir looks real, not a throwaway: ${dataDir}`);
  process.exit(3);
}
console.log(`data dir (isolated): ${dataDir}\n`);

// ── Daily log ───────────────────────────────────────────────────────────────
const day = new Date(2026, 6, 21, 14, 5); // 2026-07-21 14:05 local
const n = appendDailyLog(["Prefers bun over npm", "  ", "Ships to prod on Fridays"], day);
check("appendDailyLog writes only non-empty bullets", n === 2, `wrote ${n}`);

const logFile = dailyLogPath(day);
check("log path is logs/YYYY/MM/YYYY-MM-DD.md", logFile.endsWith(join("logs", "2026", "07", "2026-07-21.md")), logFile);
const logRaw = readFileSync(logFile, "utf-8");
check("log has a date heading", logRaw.startsWith("# 2026-07-21"));
check("bullets are timestamped", /^- 14:05 — Prefers bun over npm$/m.test(logRaw));

appendDailyLog(["A second batch"], day);
const logRaw2 = readFileSync(logFile, "utf-8");
check("append never rewrites (heading stays single)", (logRaw2.match(/^# /gm) ?? []).length === 1);
check("append keeps earlier bullets", logRaw2.includes("Prefers bun over npm") && logRaw2.includes("A second batch"));

check("readLogsSince(0) sees the bullets", readLogsSince(0).bullets === 3, `${readLogsSince(0).bullets}`);
check("pendingBulletCount(now) is 0", pendingBulletCount(Date.now() + 1000) === 0);

// A long bullet is truncated, not dropped.
appendDailyLog(["x".repeat(900)], day);
check("long bullet truncated to ~500", /x{500}…/.test(readFileSync(logFile, "utf-8")));

// ── Index ───────────────────────────────────────────────────────────────────
writeMemoryFile("topics/bun-workflow", { name: "Bun workflow", summary: "uses bun", body: "Prefers bun over npm." });
writeMemoryIndex([
  { id: "topics/bun-workflow", title: "Bun workflow", hook: "prefers bun over npm" },
  { id: "profile", title: "Pro\nfile]", hook: "who they are" },
]);
const idx = readMemoryIndex();
check("index line format `- [Title](file.md) — hook`", idx.includes("- [Bun workflow](topics/bun-workflow.md) — prefers bun over npm"));
check("index sanitises newlines/brackets in titles", /- \[Pro file\]\(profile\.md\)/.test(idx), idx.split("\n").pop());
check("index lives at MEMORY.md", indexPath().endsWith("MEMORY.md") && existsSync(indexPath()));

// Caps: 300 entries must clamp to 200 lines (+2 header lines).
writeMemoryIndex(
  Array.from({ length: 300 }, (_, i) => ({ id: `topics/t${i}`, title: `T${i}`, hook: "h" })),
);
const capped = readFileSync(indexPath(), "utf-8").split("\n").filter((l) => l.startsWith("- "));
check("index clamps to 200 lines", capped.length === 200, `${capped.length}`);

// A single absurd entry is truncated, not allowed to blow the line budget.
writeMemoryIndex([{ id: "profile", title: "T".repeat(400), hook: "h".repeat(400) }]);
const longLine = readFileSync(indexPath(), "utf-8").split("\n").find((l) => l.startsWith("- ")) ?? "";
check("over-long index line truncated to ≤200", longLine.length <= 200, `${longLine.length}`);

// ── Prompt injection ────────────────────────────────────────────────────────
writeMemoryIndex([{ id: "topics/bun-workflow", title: "Bun workflow", hook: "prefers bun" }]);
const prompt = buildMemoryPrompt() ?? "";
check("buildMemoryPrompt includes the index", prompt.includes("[Bun workflow](topics/bun-workflow.md)"));
check("buildMemoryPrompt includes the file body", prompt.includes("Prefers bun over npm."));
check("index precedes bodies", prompt.indexOf("# Memory index") < prompt.indexOf("Prefers bun over npm."));

// ── Consolidation gates ─────────────────────────────────────────────────────
// Each gate must short-circuit BEFORE the provider is called (a skipped run
// must never cost a request).
const stateFile = join(getDataDir(), "memory-consolidation.json");
const setLast = (ms: number): void => {
  let cur: Record<string, unknown> = {};
  try {
    cur = JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch {
    /* first write */
  }
  writeFileSync(stateFile, JSON.stringify({ ...cur, lastConsolidatedAt: ms }), "utf-8");
};

setLast(Date.now() - 2 * 3_600_000); // 2h ago → time gate closed
const tooSoon = await runConsolidation();
check("time gate: 2h since last → skipped", tooSoon.ran === false && /since last run/.test(tooSoon.reason ?? ""), tooSoon.reason ?? "");

// Backdate the log so it predates lastConsolidatedAt: time gate open (25h),
// but nothing new to consolidate.
utimesSync(logFile, new Date(Date.now() - 30 * 3_600_000), new Date(Date.now() - 30 * 3_600_000));
setLast(Date.now() - 25 * 3_600_000);
const noSignal = await runConsolidation();
check("signal gate: no new bullets → skipped", noSignal.ran === false && /not enough new signal/.test(noSignal.reason ?? ""), noSignal.reason ?? "");

utimesSync(logFile, new Date(), new Date()); // fresh again
const before = getConsolidationState().lastConsolidatedAt;
setLast(0); // stale + 4 pending bullets → gates open, provider is the only blocker
const opened = await runConsolidation();
check("gates open when stale with pending signal", opened.ran === false && !!opened.error, (opened.error ?? "").slice(0, 60));
check("a failed run does NOT advance lastConsolidatedAt", getConsolidationState().lastConsolidatedAt === 0);
check("a failed run leaves the logs pending", pendingBulletCount(0) > 0, `${pendingBulletCount(0)} pending`);
check("a failed run records the error", !!getConsolidationState().lastError);
void before;

// ── Nightly timing ──────────────────────────────────────────────────────────
// _shouldRunNow reads lastConsolidatedAt off disk, so drive it directly:
// for a test clock D and a desired age H, last = D - H hours.
const at = (h: number): Date => new Date(2026, 6, 21, h, 0);
const setAge = (clock: Date, hours: number): void => {
  const cur = JSON.parse(readFileSync(join(getDataDir(), "memory-consolidation.json"), "utf-8"));
  writeFileSync(
    join(getDataDir(), "memory-consolidation.json"),
    JSON.stringify({ ...cur, lastConsolidatedAt: clock.getTime() - hours * 3_600_000 }),
    "utf-8",
  );
};

setAge(at(3), 2);
check("night window but only 2h old → no run", _shouldRunNow(at(3)) === false);
setAge(at(3), 21);
check("night window and 21h old → runs", _shouldRunNow(at(3)) === true);
setAge(at(12), 21);
check("21h old but midday → no run", _shouldRunNow(at(12)) === false);
setAge(at(12), 40);
check("40h old at midday → catch-up runs", _shouldRunNow(at(12)) === true);
setAge(at(6), 21);
check("06:00 is outside the window → no run", _shouldRunNow(at(6)) === false);

console.log(`\n${failed === 0 ? "ALL MEMORY CHECKS PASSED" : `${failed} CHECK(S) FAILED`}`);
console.log(`memory dir: ${getMemoryDir()}`);
// exitCode, not exit(): a 401 socket may still be closing and process.exit()
// trips a libuv teardown assertion on Windows.
process.exitCode = failed === 0 ? 0 : 1;
