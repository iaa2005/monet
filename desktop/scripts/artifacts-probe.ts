/**
 * Checks how repeated writes of the same file collapse into versions.
 *
 * The case this exists for: a model that writes report.docx, opens it, and
 * fixes it inside ONE reply produces three artifacts. All three are real files
 * on disk (the version history), but the panel should show one document, not
 * three copies with nothing saying which is current.
 */

import {
  collectArtifacts,
  groupVersions,
  type ArtifactItem,
} from "@/lib/sessionArtifacts";
import type { ChatMessage } from "@/types/chat";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}`);
    if (detail !== undefined) console.log("      ", JSON.stringify(detail));
  }
}

function item(name: string, ts: number, path: string): ArtifactItem {
  return {
    name,
    mediaType: "application/octet-stream",
    kind: "file",
    path,
    ts,
    source: "output",
  };
}

// ─── One file written three times in a turn ────────────────────────────

const thrice = [
  item("report.docx", 1000, "a/1-report.docx"),
  item("report.docx", 1001, "a/2-report.docx"),
  item("report.docx", 1002, "a/3-report.docx"),
];
const g1 = groupVersions(thrice);
check("three writes of one file collapse to one entry", g1.length === 1, g1.length);
check(
  "the newest write is the one shown",
  g1[0]?.latest.path === "a/3-report.docx",
  g1[0]?.latest.path,
);
check(
  "the earlier two are kept, newest first",
  g1[0]?.older.map((o) => o.path).join(",") === "a/2-report.docx,a/1-report.docx",
  g1[0]?.older.map((o) => o.path),
);

// ─── Distinct files stay distinct ──────────────────────────────────────

const mixed = [
  item("site/index.html", 1000, "a/1-index.html"),
  item("docs/index.html", 1001, "a/2-index.html"),
  item("site/index.html", 1002, "a/3-index.html"),
];
const g2 = groupVersions(mixed);
check("same basename in different folders is not merged", g2.length === 2, g2.length);
check(
  "the group ordering is newest-first",
  g2[0]?.latest.name === "site/index.html",
  g2.map((g) => g.latest.name),
);
check(
  "docs/index.html has no earlier version",
  g2.find((g) => g.latest.name === "docs/index.html")?.older.length === 0,
);

// ─── Several files written by ONE run share a timestamp ────────────────

const sameTs = [
  item("a.png", 500, "a/1-a.png"),
  item("b.png", 500, "a/2-b.png"),
  item("a.png", 500, "a/3-a.png"),
];
const g3 = groupVersions(sameTs);
check("equal timestamps still group by name", g3.length === 2, g3.map((g) => g.latest.name));
check(
  "with equal timestamps the LAST write still wins",
  g3.find((g) => g.latest.name === "a.png")?.latest.path === "a/3-a.png",
  g3.find((g) => g.latest.name === "a.png")?.latest.path,
);

check("no artifacts groups to nothing", groupVersions([]).length === 0);

// ─── End to end from messages, as the panel sees it ────────────────────

const msgs: ChatMessage[] = [
  {
    id: "u1",
    role: "user",
    content: "make me a report",
    timestamp: 1,
    attachments: [
      { name: "source.csv", mediaType: "text/csv", kind: "text", path: "c/1-source.csv" },
    ],
  },
  {
    id: "t1",
    role: "tool",
    content: "",
    timestamp: 2,
    toolCall: {
      id: "1",
      name: "RunPython",
      input: {},
      status: "done",
      output:
        "[artifact] application/octet-stream report.docx :: a/1-report.docx\nSaved report.docx",
    },
  },
  {
    id: "t2",
    role: "tool",
    content: "",
    timestamp: 3,
    toolCall: {
      id: "2",
      name: "RunPython",
      input: {},
      status: "done",
      output:
        "[artifact] application/octet-stream report.docx :: a/2-report.docx\n[artifact] image/png chart.png :: a/2-chart.png",
    },
  },
] as ChatMessage[];

const collected = collectArtifacts(msgs);
check("attachments land in content", collected.content.length === 1);
check("three artifact lines were parsed", collected.output.length === 3, collected.output.length);

const groups = groupVersions(collected.output);
check(
  "the panel would show 2 files, not 3",
  groups.length === 2,
  groups.map((g) => `${g.latest.name} v${g.older.length + 1}`),
);
check(
  "report.docx shows v2 and points at the newer copy",
  groups.find((g) => g.latest.name === "report.docx")?.latest.path === "a/2-report.docx" &&
    groups.find((g) => g.latest.name === "report.docx")?.older.length === 1,
);
check(
  "an unedited file shows no version chip",
  groups.find((g) => g.latest.name === "chart.png")?.older.length === 0,
);

console.log(
  failures === 0 ? "\nALL ARTIFACT CHECKS PASSED" : `\n${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
