/**
 * The state a card shows for every combination of chosen / downloaded.
 *
 * The reported bug: a speech model that ships pre-selected but undownloaded
 * drew the same tick as one sitting on disk, so the row read as ready and the
 * download had no visible call to action — the user found it by clicking a row
 * that already looked chosen.
 *
 * Rendered to static HTML, because the thing under test IS what the row draws.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { PickCard } from "../src/renderer/components/settings/PickCard";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const html = (props: Record<string, unknown>): string =>
  renderToStaticMarkup(
    createElement(PickCard, { title: "GigaAM v3", onClick: () => {}, ...props } as never),
  );

const hasDownloadButton = (h: string): boolean => /<button[^>]*>(?:(?!<\/button>).)*Download/s.test(h);
const hasWarning = (h: string): boolean => h.includes("not on your machine yet");

// ── chosen but absent: the reported case ──────────────────────────────
{
  const h = html({ selected: true, needsDownload: true });
  check("chosen + absent → offers Download", hasDownloadButton(h));
  check("chosen + absent → says so in words", hasWarning(h));
  check("chosen + absent → still ringed as the choice", h.includes("border-brand/40"));
}

// ── chosen and present: the only place a tick belongs ─────────────────
{
  const h = html({ selected: true, needsDownload: false });
  check("chosen + present → no Download button", !hasDownloadButton(h));
  check("chosen + present → no warning", !hasWarning(h));
}

// ── unchosen and absent ───────────────────────────────────────────────
{
  const h = html({ selected: false, needsDownload: true });
  check("unchosen + absent → offers Download", hasDownloadButton(h));
  check("unchosen + absent → no warning line", !hasWarning(h));
}

// ── mid-download: progress replaces the offer ─────────────────────────
{
  const h = html({ selected: true, needsDownload: true, progress: 42 });
  check("downloading → no Download button", !hasDownloadButton(h));
  check("downloading → shows percent", h.includes("42%"));
  check("downloading → no warning line", !hasWarning(h));
}

// ── the Download button is wired independently of the row ─────────────
{
  let rowClicks = 0;
  let dlClicks = 0;
  const h = renderToStaticMarkup(
    createElement(PickCard, {
      title: "x",
      selected: true,
      needsDownload: true,
      onClick: () => rowClicks++,
      onDownload: () => dlClicks++,
    } as never),
  );
  check("onDownload renders its own button", hasDownloadButton(h), `${rowClicks}/${dlClicks}`);
}

console.log(failures === 0 ? "\npick card: PASS" : `\npick card: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
