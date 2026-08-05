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
      {/* Outer shard */}
      <path d="M12 2 L20 9 L16.5 21.5 L7.5 21.5 L4 9 Z" />
      {/* Facets meeting low-left, the way the real mineral fractures */}
      <path d="M12 2 L9.5 21.5" />
      <path d="M20 9 L9.5 21.5" />
    </svg>
  );
}
