/**
 * Web tools (desktop-native, no API key required).
 *
 * The vendor WebFetch/WebSearch tools are tied to Anthropic's fetch proxy /
 * Brave API. These self-contained versions work with any provider (deepseek
 * included): WebFetch fetches a URL and returns readable text; WebSearch uses
 * DuckDuckGo's keyless HTML endpoint.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import TurndownService from "turndown";
import { buildTool } from "../engine/Tool.js";
import { lazySchema } from "./lazy-schema.js";

const UA =
  process.platform === "darwin"
    ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_CHARS = 40_000;

async function fetchText(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: string; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "User-Agent": UA, ...(init?.headers ?? {}) },
      redirect: "follow",
    });
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      body,
      contentType: res.headers.get("content-type") ?? "",
    };
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── WebFetch ──────────────────────────────────────────────────────────────

const fetchSchema = lazySchema(() =>
  z.strictObject({
    url: z.string().describe("The absolute URL to fetch (http/https)."),
    prompt: z
      .string()
      .optional()
      .describe("What to extract or look for on the page (optional)."),
  }),
);
type FetchSchema = ReturnType<typeof fetchSchema>;

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

export const WebFetchTool = buildTool({
  name: "WebFetch",
  searchHint: "fetch a web page and read its content",
  maxResultSizeChars: MAX_CHARS + 2_000,
  get inputSchema(): FetchSchema {
    return fetchSchema();
  },
  userFacingName() {
    return "WebFetch";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  isOpenWorld() {
    return true;
  },
  async prompt() {
    return "Fetch a URL and return its readable content as text/markdown. Use it to read documentation, articles, or any web page. Provide an optional `prompt` describing what to look for.";
  },
  async description() {
    return "Fetch a web page and return its readable text content.";
  },
  async call({ url, prompt }: z.infer<FetchSchema>) {
    if (!/^https?:\/\//i.test(url)) {
      return { data: { text: `Error: invalid URL: ${url}`, isError: true } };
    }
    try {
      const res = await fetchText(url);
      if (!res.ok) {
        return {
          data: { text: `Error: HTTP ${res.status} fetching ${url}`, isError: true },
        };
      }
      let text: string;
      if (/text\/html|application\/xhtml/i.test(res.contentType)) {
        const cleaned = res.body
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
        try {
          text = turndown.turndown(cleaned);
        } catch {
          text = stripTags(cleaned);
        }
      } else {
        text = res.body;
      }
      text = text.replace(/\n{3,}/g, "\n\n").trim();
      const truncated = text.length > MAX_CHARS;
      if (truncated) text = text.slice(0, MAX_CHARS) + "\n\n… (truncated)";
      const header = `Fetched ${url}${prompt ? ` — looking for: ${prompt}` : ""}\n\n`;
      return { data: { text: header + text, isError: false } };
    } catch (err) {
      return {
        data: {
          text: `Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        },
      };
    }
  },
  mapToolResultToToolResultBlockParam(
    content: { text: string; isError: boolean },
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      type: "tool_result",
      tool_use_id: toolUseID,
      content: content.text,
      is_error: content.isError || undefined,
    };
  },
  renderToolUseMessage() {
    return null;
  },
});

// ─── WebSearch (DuckDuckGo, keyless) ─────────────────────────────────────────

const searchSchema = lazySchema(() =>
  z.strictObject({
    query: z.string().describe("The search query."),
  }),
);
type SearchSchema = ReturnType<typeof searchSchema>;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeDdgHref(href: string): string {
  // DDG wraps results as /l/?uddg=<encoded real url>
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* fall through */
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

function parseDdg(html: string, limit = 8): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe =
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]));
  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html)) && results.length < limit) {
    const url = decodeDdgHref(lm[1]);
    const title = stripTags(lm[2]);
    if (!title || !url) continue;
    results.push({ title, url, snippet: snippets[i] ?? "" });
    i++;
  }
  return results;
}

/** lite.duckduckgo.com markup: bare result links + result-snippet cells. */
function parseDdgLite(html: string, limit = 8): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRe = /<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]));
  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html)) && results.length < limit) {
    const url = decodeDdgHref(lm[1]);
    const title = stripTags(lm[2]);
    if (!title || !url || /duckduckgo\.com/i.test(url)) continue;
    results.push({ title, url, snippet: snippets[i] ?? "" });
    i++;
  }
  return results;
}

/** True when the response is an anti-bot/captcha interstitial, not results. */
function looksBlocked(html: string): boolean {
  return /anomaly-modal|challenge-form|verifying you are human|captcha|detected unusual traffic/i.test(
    html.slice(0, 6000),
  );
}

/**
 * DDG anti-bot behaviour changes per endpoint/method (verified live):
 * html+lite POST → 202 interstitial; lite GET with browser-ish headers →
 * real results. Try in reliability order and DISTINGUISH "blocked" from
 * "genuinely nothing found" so the model reacts correctly instead of
 * concluding the information doesn't exist.
 */
async function ddgSearch(
  query: string,
): Promise<{ results: SearchResult[]; blocked: boolean }> {
  const q = encodeURIComponent(query);
  const browserish = {
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
  };
  const attempts: {
    url: string;
    init?: RequestInit;
    parse: (h: string) => SearchResult[];
  }[] = [
    {
      url: `https://lite.duckduckgo.com/lite/?q=${q}`,
      init: { headers: browserish },
      parse: parseDdgLite,
    },
    {
      url: `https://html.duckduckgo.com/html/?q=${q}`,
      init: { headers: browserish },
      parse: parseDdg,
    },
    {
      url: "https://html.duckduckgo.com/html/",
      init: {
        method: "POST",
        headers: {
          ...browserish,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `q=${q}`,
      },
      parse: parseDdg,
    },
  ];
  let blocked = false;
  for (const attempt of attempts) {
    try {
      const res = await fetchText(attempt.url, attempt.init);
      if (!res.ok) {
        if (res.status === 403 || res.status === 429) blocked = true;
        continue;
      }
      if (looksBlocked(res.body)) {
        blocked = true;
        continue;
      }
      const results = attempt.parse(res.body);
      if (results.length > 0) return { results, blocked: false };
    } catch {
      /* try the next endpoint */
    }
  }
  return { results: [], blocked };
}

export const WebSearchTool = buildTool({
  name: "WebSearch",
  searchHint: "search the web (DuckDuckGo)",
  maxResultSizeChars: 20_000,
  get inputSchema(): SearchSchema {
    return searchSchema();
  },
  userFacingName() {
    return "WebSearch";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  isOpenWorld() {
    return true;
  },
  async prompt() {
    return "Search the web (via DuckDuckGo) and return the top results with titles, URLs and snippets. Follow up with WebFetch to read a result in full.";
  },
  async description() {
    return "Search the web and return the top results (title, URL, snippet).";
  },
  async call({ query }: z.infer<SearchSchema>) {
    try {
      const { results, blocked } = await ddgSearch(query);
      if (results.length === 0) {
        return {
          data: {
            text: blocked
              ? `Search backend rate-limited the request for "${query}" (not a lack of results). Do NOT retry immediately with variations — wait, batch what you know, or use WebFetch on a likely source (Wikipedia, official docs, a news site) instead.`
              : `No results for "${query}". Try shorter/simpler keywords (English often works best), without quotes or operators.`,
            isError: blocked,
          },
        };
      }
      const text =
        `Search results for "${query}":\n\n` +
        results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
          .join("\n\n");
      return { data: { text, isError: false } };
    } catch (err) {
      return {
        data: {
          text: `Error searching: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        },
      };
    }
  },
  mapToolResultToToolResultBlockParam(
    content: { text: string; isError: boolean },
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      type: "tool_result",
      tool_use_id: toolUseID,
      content: content.text,
      is_error: content.isError || undefined,
    };
  },
  renderToolUseMessage() {
    return null;
  },
});
