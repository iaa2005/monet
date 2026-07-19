/**
 * Convert standard markdown to Telegram HTML.
 *
 * Telegram supports a subset of HTML (parse_mode: "HTML"):
 *   <b>, <i>, <u>, <s>, <code>, <pre>, <a href="…">, <blockquote>
 *
 * Standard markdown uses **bold**, *italic*, ~~strike~~, `code`, ```block```,
 * [text](url) — all of which MarkdownV2 does NOT understand as-is (it wants
 * *bold*, _italic_, ~strike~ and heavy escaping of . ! - ( ) etc.). Converting
 * to HTML avoids the escaping minefield entirely: only < > & need escaping.
 *
 * The converter is deliberately small: it covers the formatting an LLM is
 * likely to emit, escapes what HTML needs escaped, and leaves anything it
 * doesn't recognise as literal text. Unknown/ malformed markdown survives as
 * visible characters rather than silently disappearing.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert markdown → Telegram HTML.
 *
 * Order matters: code blocks/inline code are extracted FIRST (their contents
 * must not be touched by the inline formatter), then links, then the inline
 * emphasis rules. What's left is HTML-escaped so stray < > & stay literal.
 */
export function markdownToTelegramHtml(md: string): string {
  // Protect code blocks (```…```) and inline code (`…`) from further parsing.
  // We slot them back in at the end.
  const codeBlocks: string[] = [];
  let work = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    const block = code.replace(/\n$/, "");
    codeBlocks.push(
      _lang
        ? `<pre><code class="language-${escapeHtml(_lang)}">${escapeHtml(block)}</code></pre>`
        : `<pre><code>${escapeHtml(block)}</code></pre>`,
    );
    return `\x00${codeBlocks.length - 1}\x00`;
  });
  const inlineCodes: string[] = [];
  work = work.replace(/`([^`]+)`/g, (_m, code) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x01${inlineCodes.length - 1}\x01`;
  });

  // Escape the rest (user text, not code).
  work = escapeHtml(work);

  // Links: [text](url) — the URL goes into an attribute, escape it too.
  work = work.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, text, url) => `<a href="${url}">${text}</a>`,
  );
  // Bare URLs become clickable links.
  work = work.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (_m, pre, url) => `${pre}<a href="${url}">${url}</a>`,
  );

  // Inline emphasis — standard markdown syntax.
  // Bold: **text** or __text__ → <b>
  work = work.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  work = work.replace(/__([^_]+)__/g, "<b>$1</b>");
  // Italic: *text* or _text_ → <i>. Run AFTER bold so ** isn't mis-parsed.
  work = work.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  work = work.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<i>$2</i>");
  // Strikethrough: ~~text~~ → <s>
  work = work.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  // Underline: __text__ is bold above; markdown has no standard underline,
  // but ++text++ is a common extension — skip, Telegram has <u> but rare.

  // Blockquotes: lines starting with > → <blockquote>
  // (Telegram supports <blockquote> as of 2023.)
  work = work.replace(/(?:^|\n)&gt;\s?(.*)/g, (line) => {
    const content = line.replace(/(?:^|\n)&gt;\s?/, "\n");
    return `\n<blockquote>${content.trim()}</blockquote>`;
  });

  // Restore inline code and code blocks.
  work = work.replace(/\x01(\d+)\x01/g, (_m, i) => inlineCodes[Number(i)]!);
  work = work.replace(/\x00(\d+)\x00/g, (_m, i) => codeBlocks[Number(i)]!);

  return work.trim();
}
