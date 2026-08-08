/**
 * Clicking a link to an already-open file has to bring it to the front.
 *
 * Reported: the file is open, but its tab is not the one showing. You click
 * the link and nothing happens — then you click the tab. Two actions for
 * one intention.
 *
 * The cause is that "which file is being looked at" was expressed only as
 * `activeId`, and re-opening the file that is already active sets that to
 * the value it already had. Nothing changed, so the effect that raises the
 * panel never ran, and the dock went on showing whatever tab it was
 * showing.
 *
 * So there is a second signal — a counter that rises every time somebody
 * ASKS for a file — and the raise is keyed on that too. The rules it has to
 * obey are exactly two, and they pull in opposite directions:
 *
 *   - asking for the file that is already active MUST count as a request;
 *   - clicking INSIDE a card must NOT, or the panel re-raises under the
 *     typing hand and the caret goes with it.
 *
 *   npm run smoke:viewerraise
 */

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

const S = () => useViewerStore.getState();
const file = (name: string, path: string) => ({
  name,
  path,
  mediaType: "text/markdown",
  kind: "file" as const,
  source: "file" as const,
});

const notes = file("notes.md", "D:/vault/notes.md");
const other = file("other.md", "D:/vault/other.md");

// ─── The reported case ──────────────────────────────────────────────────

{
  S().closeAll();
  S().open(notes, { preview: false });
  const first = { id: S().activeId, seq: S().raiseSeq };
  check("opening a file makes it the active card", first.id !== null, first);

  // Clicking the same link again — the file is already open AND already the
  // store's active one. This is the exact shape that did nothing.
  S().open(notes, { preview: false });
  check(
    "the active id does not change, because it was already right",
    S().activeId === first.id,
    { was: first.id, now: S().activeId },
  );
  check(
    "BUT THE REQUEST IS STILL COUNTED — the panel gets raised",
    S().raiseSeq > first.seq,
    { was: first.seq, now: S().raiseSeq },
  );
}

// ─── Clicking inside a card must not raise it ───────────────────────────

{
  S().closeAll();
  S().open(notes, { preview: false });
  const id = S().activeId as string;
  const before = S().raiseSeq;
  S().setActive(id);
  check(
    "SETTING ACTIVE IS NOT A REQUEST — no raise, no stolen caret",
    S().raiseSeq === before,
    { was: before, now: S().raiseSeq },
  );
  check("…though it is still the active card", S().activeId === id);
}

// ─── The other ways a file is asked for ─────────────────────────────────

{
  S().closeAll();
  const start = S().raiseSeq;
  S().open(notes, { preview: false });
  check("a brand new card counts", S().raiseSeq > start, S().raiseSeq);

  const afterFirst = S().raiseSeq;
  S().open(other, { preview: true });
  check("so does a different file", S().raiseSeq > afterFirst);
  check("…and it is the one in front", S().activeId !== null);

  // The single preview card, reused by every click while walking a tree.
  const afterPreview = S().raiseSeq;
  const previewId = S().activeId;
  S().open(file("third.md", "D:/vault/third.md"), { preview: true });
  check(
    "reusing THE preview card counts as a request too",
    S().raiseSeq > afterPreview,
    { was: afterPreview, now: S().raiseSeq },
  );
  check(
    "…and it is the same card, renamed rather than a new one",
    S().activeId === previewId,
    { previewId, now: S().activeId },
  );
}

// ─── It only ever rises ─────────────────────────────────────────────────

{
  S().closeAll();
  const seen: number[] = [];
  for (let i = 0; i < 5; i++) {
    S().open(notes, { preview: false });
    seen.push(S().raiseSeq);
  }
  check(
    "the signal is monotonic — every click is its own request",
    seen.every((v, i) => i === 0 || v > seen[i - 1]),
    seen,
  );
}

console.log(
  failures
    ? `\n${failures} FAILED`
    : "\nASKING FOR AN OPEN FILE BRINGS IT TO THE FRONT",
);
process.exit(failures ? 1 : 0);
