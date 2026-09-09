/**
 * Opening a file that has not been sent yet.
 *
 * A composer tile is 144 pixels: enough to recognise a scan, not enough to
 * read one. Clicking it now opens the same viewer everything else in the app
 * opens into — which is the whole point, one preview pipeline rather than a
 * second one that drifts — and the two things that can go wrong are both
 * about a file that is not on disk:
 *
 *   1. SIZE. There is no upper bound on what someone attaches. Whatever is
 *      streamed by the browser (image, pdf, audio, video) is free; whatever
 *      must be held as a string or parsed whole is not, and the difference
 *      between "shows a 2 GB video" and "freezes on a 2 GB video" is which
 *      of those a format falls into.
 *   2. IDENTITY AND LIFETIME. A staged file has no path, so the viewer finds
 *      it by (draft key, attachment id) — two files can share a name — and
 *      the card cannot outlive the attachment or survive a reload.
 *
 *   npm run smoke:staged
 */

import {
  MAX_STAGED_PARSE_BYTES,
  MAX_STAGED_TEXT_BYTES,
  humanBytes,
  planStagedPreview,
  tooBigMessage,
  truncatedNote,
} from "@/lib/staged-preview";
import { useViewerStore } from "@/stores/viewerStore";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(
      `FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
    );
  }
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

// ─── Size: what may be read, and how much of it ─────────────────────────

// The case this is for. Someone attaches a phone video and clicks the tile.
for (const kind of ["image", "pdf", "audio", "video"]) {
  check(
    `a 2 GB ${kind} is streamed, not read`,
    planStagedPreview(kind, 2 * GB) === "stream",
    planStagedPreview(kind, 2 * GB),
  );
}
check(
  "…and so is a small one — there is no size at which this changes",
  planStagedPreview("image", 12_000) === "stream",
);

// Text is held as a string, so only the front of it is.
check("text is read from the front", planStagedPreview("text", 400 * MB) === "head");
check("however small it is", planStagedPreview("text", 200) === "head");
check(
  "and the note says what was shown and what the file is",
  ((): boolean => {
    const note = truncatedNote(MAX_STAGED_TEXT_BYTES, 400 * MB);
    return note.includes("391 KB") && note.includes("400.0 MB");
  })(),
  truncatedNote(MAX_STAGED_TEXT_BYTES, 400 * MB),
);

// Zip archives and one-document JSON have no partial reading.
for (const kind of ["docx", "xlsx", "notebook"]) {
  check(`a small ${kind} is parsed whole`, planStagedPreview(kind, 2 * MB) === "parse");
  check(
    `a huge ${kind} is refused instead of freezing the window`,
    planStagedPreview(kind, 300 * MB) === "too-big",
    planStagedPreview(kind, 300 * MB),
  );
}
check(
  "the ceiling is a boundary, not a range",
  planStagedPreview("docx", MAX_STAGED_PARSE_BYTES) === "parse" &&
    planStagedPreview("docx", MAX_STAGED_PARSE_BYTES + 1) === "too-big",
);
check(
  "and the refusal says the file is still sent — nothing was lost",
  /sent in full/.test(tooBigMessage(300 * MB)),
  tooBigMessage(300 * MB),
);
check(
  "an opaque type says so rather than guessing",
  planStagedPreview("none", 10) === "none",
);

check("bytes read the way people write them", humanBytes(900) === "900 B");
check("…kilobytes", humanBytes(2048) === "2 KB");
check("…megabytes", humanBytes(5 * MB) === "5.0 MB");
check("…and gigabytes, rather than 2048.0 MB", humanBytes(2 * GB) === "2.0 GB");

// ─── Identity and lifetime in the viewer ────────────────────────────────

const S = (): ReturnType<typeof useViewerStore.getState> =>
  useViewerStore.getState();
const staged = (name: string, id: string) => ({
  name,
  mediaType: "image/png",
  kind: "image",
  source: "staged" as const,
  stagedKey: "new:code",
  stagedId: id,
});

S().closeAll();
S().open(staged("scan.png", "a1"), { maximize: true });
check("a staged file opens a card", S().docs.length === 1, S().docs.length);
check("and asks for the whole window", S().maximizeSeq > 0);

// Two attachments, one name — the case that decides whether identity is the
// name or the id. Dropping the same photo twice is a thing people do, and
// with identity by name the second tile would open the first file.
S().closeAll();
S().open(staged("scan.png", "a1"), { preview: false });
S().open(staged("scan.png", "b2"), { preview: false });
check(
  "TWO ATTACHMENTS SHARING A NAME ARE TWO FILES",
  S().docs.length === 2,
  S().docs.map((d) => d.file.stagedId),
);
check(
  "…and the second one is the one being looked at",
  S().docs.find((d) => d.id === S().activeId)?.file.stagedId === "b2",
  S().docs.find((d) => d.id === S().activeId)?.file.stagedId,
);

// Re-opening the SAME attachment is not a third card.
const before = S().docs.length;
const raise = S().raiseSeq;
S().open(staged("scan.png", "a1"));
check("re-opening one of them reuses its card", S().docs.length === before, S().docs.length);
check(
  "…and raises that one, not the other",
  S().docs.find((d) => d.id === S().activeId)?.file.stagedId === "a1",
);
check("…and still counts as a request to see it", S().raiseSeq > raise);

// A maximize is only asked for when it is asked for.
const maxSeq = S().maximizeSeq;
S().open(staged("other.png", "c3"));
check(
  "opening without maximize leaves the window alone",
  S().maximizeSeq === maxSeq,
  { before: maxSeq, after: S().maximizeSeq },
);

// ─── It cannot be restored, so it is not saved ──────────────────────────
//
// The File behind a staged doc does not survive a reload. Persisting the card
// would reopen a tab whose only possible content is an error.
S().closeAll();
// Pinned, because a single click opens a PREVIEW card and the next single
// click reuses it — clicking a tile while a preview is open replaces it,
// which is the app's idiom everywhere and not something to work around here.
S().open(
  {
    name: "notes.md",
    path: "/w/notes.md",
    mediaType: "text/markdown",
    kind: "file",
    source: "file",
  },
  { preview: false },
);
S().open(staged("scan.png", "a1"));
check("both cards are open", S().docs.length === 2, S().docs.map((d) => d.file.name));
const snap = S().serialize();
check(
  "a real file is saved with the desk",
  snap.some((d) => d.file.path === "/w/notes.md"),
  snap,
);
check(
  "A STAGED ONE IS NOT — it could only come back broken",
  !snap.some((d) => d.file.name === "scan.png"),
  snap.map((d) => d.file.name),
);

console.log(
  failures ? `\n${failures} FAILED` : "\nSTAGED-PREVIEW CHECKS PASSED",
);
process.exit(failures ? 1 : 0);
