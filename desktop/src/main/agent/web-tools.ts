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
import { buildTool } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
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
      const res = await fetchText(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      );
      if (!res.ok) {
        return {
          data: { text: `Error: search failed (HTTP ${res.status})`, isError: true },
        };
      }
      const results = parseDdg(res.body);
      if (results.length === 0) {
        return { data: { text: `No results for "${query}".`, isError: false } };
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
