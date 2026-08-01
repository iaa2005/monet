/**
 * One icon per kind of reference, in the two forms the app draws chips in.
 *
 * A chip used to be a chip: everything the user pointed at — an element on a
 * page, lines of code, a file, another chat — arrived wearing the browser's
 * mouse-pointer square, which said "this came from somewhere" and nothing
 * else. The kind is already known (selection-marks reads it off the block's
 * tag), so the chip can simply say it.
 *
 * The paths live here once because the two chips are built differently and
 * must not drift: the composer's chip is raw DOM (the input hands nodes to
 * the browser, so there is no JSX), the transcript's is a React element.
 */

import type { RefKind } from "@/lib/selection-marks";

/** lucide, written out: square-mouse-pointer, code-xml, file, cloud. */
const PATHS: Record<RefKind, string> = {
  browser:
    '<path d="M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"/>' +
    '<path d="m12 12 4 10 1.7-4.3L22 16Z"/>',
  code:
    '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
  file:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>' +
    '<path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  chat: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
};

const ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round"';

/** Markup for the composer's chip, which is assembled as DOM. */
export function chipIconSvg(kind: RefKind): string {
  return `<svg ${ATTRS} width="12" height="12" style="flex:none">${PATHS[kind] ?? PATHS.browser}</svg>`;
}

/** The same icon for the transcript's chip. */
export function ChipIcon({
  kind,
  className,
}: {
  kind: RefKind;
  className?: string;
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "size-3 shrink-0"}
      dangerouslySetInnerHTML={{ __html: PATHS[kind] ?? PATHS.browser }}
    />
  );
}
