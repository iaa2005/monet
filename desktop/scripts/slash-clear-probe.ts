/**
 * /clear forgets the conversation on BOTH sides.
 *
 * It did not. `clearMessages` empties the in-memory buffer and leaves
 * `hydrated: false`, which means "this is only part of the history" — so the
 * next save splices the database rows back in front of it (mergeForSave), and
 * persistSession would not have written the empty buffer anyway, because it
 * returns early on one. Net effect: the chat looked cleared, and came back
 * whole on reopen. Reported from use, not from reading.
 *
 * Drives the real store against a stubbed sessions API and checks what
 * actually reaches the database.
 *
 *   npm run smoke:slashclear
 */

import { useChatStore } from "@/stores/chatStore";
import { mergeForSave } from "@/stores/merge-for-save";

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

type Saved = { id: string; title: string; messages: { id: string }[] };
const saves: Saved[] = [];
const DB_ROWS = [
  { id: "old-1", role: "user" as const, content: "first", timestamp: 1 },
  { id: "old-2", role: "assistant" as const, content: "reply", timestamp: 2 },
];

const bridge = {
  sessions: {
    getById: async () => ({
      id: "s1",
      title: "A chat",
      space: "code",
      messages: DB_ROWS,
    }),
    save: async (s: Saved) => {
      saves.push(s);
    },
    updateTitle: async () => {},
  },
  chat: { reset: async () => ({ ok: true }) },
};

(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { electronAPI: unknown }).electronAPI = bridge;
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

// ─── THE MECHANISM THAT RESURRECTED THE CHAT ────────────────────────────
//
// Pinned on its own, because this is the part that made the bug invisible:
// an un-hydrated empty buffer does not stay empty on the way to the database.
{
  const revived = mergeForSave([], false, DB_ROWS);
  check(
    "AN UN-HYDRATED EMPTY BUFFER GETS THE OLD ROWS BACK — this is what /clear hit",
    revived.length === 2,
    revived.length,
  );
  const kept = mergeForSave([], true, DB_ROWS);
  check(
    "…while a HYDRATED empty buffer is taken at its word",
    kept.length === 0,
    kept.length,
  );
}

// ─── What /clear does now ───────────────────────────────────────────────

{
  useChatStore.getState().setCurrentSessionId("s1");
  useChatStore.getState().addUserMessage("something to forget");
  check(
    "the chat has something in it to begin with",
    useChatStore.getState().messages.length === 1,
  );

  await useChatStore.getState().clearHistory();

  check("the screen is empty", useChatStore.getState().messages.length === 0);
  check(
    "THE DATABASE WAS WRITTEN, not skipped for being empty",
    saves.length === 1,
    saves,
  );
  check(
    "…with no messages, which is what deletes the rows",
    saves[0]?.messages.length === 0,
    saves[0],
  );
  check(
    "…keeping the chat's own title rather than renaming it",
    saves[0]?.title === "A chat",
    saves[0]?.title,
  );
}

// ─── And the empty state survives a later save ──────────────────────────
//
// The real test of "cleared": whatever persists next must not bring it back.
{
  const live = useChatStore.getState().sessions["s1"];
  check(
    "the cleared buffer is marked hydrated, so nothing re-splices the rows",
    live?.hydrated === true,
    live?.hydrated,
  );
  const afterAnotherSave = mergeForSave(
    live?.messages ?? [],
    live?.hydrated === true,
    DB_ROWS,
  );
  check(
    "…so a later save still writes nothing back",
    afterAnotherSave.length === 0,
    afterAnotherSave.length,
  );
}

console.log(failures ? `\n${failures} FAILED` : "\nCLEARED MEANS CLEARED");
process.exit(failures ? 1 : 0);
