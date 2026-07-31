/**
 * What the bookmark and visit-history rules actually promise.
 *
 * The load-bearing decision is the KEY — what counts as "the same page".
 * Fragments collapse, trailing slashes collapse, queries do not. Get that
 * wrong in either direction and the UI lies: too loose and `?page=2` never
 * shows up, too strict and the Recent list shows one page three times and
 * the star un-stars a different spelling than it starred.
 */

import {
  isBookmarked,
  pushVisit,
  recentForDisplay,
  recordable,
  retitleVisit,
  toggleBookmark,
  visitKey,
  type Bookmark,
  type Visit,
} from "../src/main/browser/bookmark-store";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
};

// ── 1. The key: what is one page ──────────────────────────────────────
{
  check(
    "a fragment does not make a new page",
    visitKey("https://a.dev/docs#install") === visitKey("https://a.dev/docs"),
  );
  check(
    "nor does a trailing slash",
    visitKey("https://a.dev/docs/") === visitKey("https://a.dev/docs"),
  );
  check(
    "the root slash is left alone",
    visitKey("https://a.dev/") === "https://a.dev/",
    visitKey("https://a.dev/"),
  );
  check(
    "a query IS a different page",
    visitKey("https://a.dev/list?page=2") !== visitKey("https://a.dev/list"),
  );
  check(
    "different paths stay different",
    visitKey("https://a.dev/a") !== visitKey("https://a.dev/b"),
  );
  check("an unparsable string is its own key", visitKey("not a url") === "not a url");
}

// ── 2. What gets recorded at all ──────────────────────────────────────
{
  check("http is a place", recordable("http://localhost:5173/"));
  check("https is a place", recordable("https://github.com/pulls"));
  check("a local file is a place", recordable("file:///D:/notes/todo.html"));
  check("about:blank is every new tab, not a place", !recordable("about:blank"));
  check("data: is a document, not a place", !recordable("data:text/html,hi"));
  check("devtools is not a place", !recordable("devtools://devtools/bundled"));
  check("empty is nothing", !recordable(""));
}

// ── 3. The visit log: move to front, keep the title, stay bounded ─────
{
  let log: Visit[] = [];
  log = pushVisit(log, { url: "https://a.dev/x", title: "", at: 1 });
  log = pushVisit(log, { url: "https://b.dev/y", title: "B page", at: 2 });
  check("visits stack newest-first", log[0]!.url === "https://b.dev/y");

  // The navigation fires before the <title> is known…
  log = retitleVisit(log, "https://a.dev/x", "A page");
  check("…and the title catches up by key", log[1]!.title === "A page");

  // A revisit MOVES the entry — spelled differently, still the same page.
  log = pushVisit(log, { url: "https://a.dev/x/#top", title: "", at: 3 });
  check("a revisit moves, not duplicates", log.length === 2, log.length);
  check("to the front", visitKey(log[0]!.url) === visitKey("https://a.dev/x"));
  check("keeping the known title over an empty one", log[0]!.title === "A page");

  log = pushVisit(log, { url: "about:blank", title: "", at: 4 });
  check("about:blank never enters the log", log.length === 2);

  let capped: Visit[] = [];
  for (let i = 0; i < 30; i++)
    capped = pushVisit(capped, { url: `https://s.dev/p${i}`, title: "", at: i }, 10);
  check("the log stays at its cap", capped.length === 10, capped.length);
  check("dropping the OLDEST", capped[9]!.url === "https://s.dev/p20");
}

// ── 4. The star: toggle by key, both directions ───────────────────────
{
  let list: Bookmark[] = [];
  const r1 = toggleBookmark(list, { url: "https://a.dev/docs", title: "Docs" });
  list = r1.list;
  check("first press stars", r1.bookmarked && list.length === 1);
  check("and the page reads as starred", isBookmarked(list, "https://a.dev/docs"));
  check(
    "under any spelling of itself",
    isBookmarked(list, "https://a.dev/docs/#usage"),
  );

  const r2 = toggleBookmark(list, { url: "https://a.dev/docs/", title: "Docs" });
  check(
    "second press un-stars even spelled differently",
    !r2.bookmarked && r2.list.length === 0,
    `${r2.list.length} left`,
  );

  const r3 = toggleBookmark(list, { url: "https://a.dev/list?page=2", title: "p2" });
  check("a different query is a separate star", r3.bookmarked && r3.list.length === 2);
}

// ── 5. Recent-for-display: no page appears twice on the empty tab ─────
{
  const bookmarks = toggleBookmark([], {
    url: "https://a.dev/docs",
    title: "Docs",
  }).list;
  const log: Visit[] = [
    { url: "https://a.dev/docs/", title: "Docs", at: 3 },
    { url: "https://b.dev/", title: "B", at: 2 },
    { url: "https://c.dev/", title: "C", at: 1 },
  ];
  const shown = recentForDisplay(log, bookmarks, 5);
  check(
    "a bookmarked page is not also 'recent'",
    shown.length === 2 && shown.every((v) => !v.url.includes("a.dev")),
    shown.map((v) => v.url).join(", "),
  );
  check("the limit is a limit", recentForDisplay(log, [], 1).length === 1);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL BOOKMARK-STORE CHECKS PASSED");
process.exit(failures ? 1 : 0);
