/**
 * Bookmarks and visit history — the rules, without the disk.
 *
 * Two lists behind the empty tab: bookmarks the user chose, and a rolling log
 * of where they have been. Both are keyed by a normalised URL, because the
 * same page arrives spelled three ways — with a fragment, with a trailing
 * slash, without — and a "recent" list that shows all three spellings of one
 * page is a list of one page pretending to be three.
 *
 * Dependency-free on purpose: what counts as "the same page" and what a visit
 * log keeps are exactly the decisions worth holding in a probe.
 */

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  addedAt: number;
}

export interface Visit {
  url: string;
  title: string;
  at: number;
}

/** How many visits the log keeps. Enough for "where was I", not a history. */
export const VISIT_CAP = 200;

/**
 * The identity of a page, for deduplication.
 *
 * The fragment goes: `#install` and `#usage` are one document. The trailing
 * slash goes too — servers treat `/docs` and `/docs/` alike far more often
 * than not. The query stays: `?page=2` is genuinely a different page.
 */
export function visitKey(url: string): string {
  try {
    // Rebuilt from parts rather than serialised, which is also what drops the
    // fragment: origin + path + search simply never includes it.
    const u = new URL(url);
    let path = u.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return `${u.origin}${path}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * Is this URL worth remembering at all?
 *
 * Pages the user can want back: http(s) and local files. Everything else —
 * about:blank (every new tab), data: URLs (inline documents with unbounded
 * length), devtools, chrome — is plumbing, not somewhere they went.
 */
export function recordable(url: string): boolean {
  return /^(https?|file):/i.test(url) && !/^about:/i.test(url);
}

/**
 * Add a visit to the front of the log.
 *
 * A revisit MOVES the entry rather than duplicating it — the log answers
 * "where was I recently", and the honest answer to visiting a page twice is
 * once, at the newer time. The old title survives until a better one arrives:
 * navigation events fire before the <title> is known, and overwriting a real
 * title with "" would blank the list on every revisit.
 */
export function pushVisit(log: Visit[], visit: Visit, cap = VISIT_CAP): Visit[] {
  if (!recordable(visit.url)) return log;
  const key = visitKey(visit.url);
  const prior = log.find((v) => visitKey(v.url) === key);
  const kept: Visit = {
    url: visit.url,
    title: visit.title || prior?.title || "",
    at: visit.at,
  };
  return [kept, ...log.filter((v) => visitKey(v.url) !== key)].slice(0, cap);
}

/** The page told us its title, usually a moment after the navigation. */
export function retitleVisit(log: Visit[], url: string, title: string): Visit[] {
  if (!title) return log;
  const key = visitKey(url);
  return log.map((v) => (visitKey(v.url) === key ? { ...v, title } : v));
}

export function isBookmarked(list: Bookmark[], url: string): boolean {
  const key = visitKey(url);
  return list.some((b) => visitKey(b.url) === key);
}

/**
 * Star pressed: add the page, or remove it if it is already there.
 *
 * Removal matches by KEY, not by string — the star must un-star the page the
 * user is looking at even if it was bookmarked under a slightly different
 * spelling, or it turns into a star that adds a second copy.
 */
export function toggleBookmark(
  list: Bookmark[],
  page: { url: string; title: string },
  now = Date.now(),
): { list: Bookmark[]; bookmarked: boolean } {
  const key = visitKey(page.url);
  if (list.some((b) => visitKey(b.url) === key)) {
    return { list: list.filter((b) => visitKey(b.url) !== key), bookmarked: false };
  }
  const bookmark: Bookmark = {
    id: `bm-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    url: page.url,
    title: page.title,
    addedAt: now,
  };
  return { list: [...list, bookmark], bookmarked: true };
}

/** Recent visits worth showing: not blank, and not already a bookmark row. */
export function recentForDisplay(
  log: Visit[],
  bookmarks: Bookmark[],
  limit: number,
): Visit[] {
  return log
    .filter((v) => recordable(v.url) && !isBookmarked(bookmarks, v.url))
    .slice(0, limit);
}
