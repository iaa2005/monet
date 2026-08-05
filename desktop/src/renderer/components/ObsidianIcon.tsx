/**
 * The Obsidian mark for this app: a shard of volcanic stone.
 *
 * Lucide has gems and mountains but no stone, and the Gem icon read as
 * jewellery. This is a faceted shard in lucide's own dialect (24-box,
 * stroke-only, width 2, round joins) so it sits in a row of lucide icons
 * without looking imported.
 */

import type { SVGProps } from "react";

export function ObsidianIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="M11.264 2.205A4 4 0 0 0 6.42 4.211l-4 8a4 4 0 0 0 1.359 5.117l6 4a4 4 0 0 0 4.438 0l6-4a4 4 0 0 0 1.576-4.592l-2-6a4 4 0 0 0-2.53-2.53z"/><path d="M11.99 22 14 12l7.822 3.184"/><path d="M14 12 8.47 2.302"/>
    </svg>
  );
}
