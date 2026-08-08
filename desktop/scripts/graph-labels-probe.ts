/**
 * The vault graph, zoomed all the way out, still had its names on.
 *
 * Reported with a screenshot: the dots shrink, the labels do not — they are
 * drawn at a constant 9.5px on SCREEN, which is right for reading and wrong
 * for looking at the whole vault. Zooming out only brought the hub names
 * closer together until four of them sat on top of each other.
 *
 * What has to hold:
 *
 *   - far out, no names at all. That is the reported bug, and the old rule
 *     (`scale > 0.9 || radius > 6`) had no distance term on the second half,
 *     so every hub kept its label at every zoom;
 *   - the pointer wins anyway. Zoomed out is exactly when "what is this
 *     dot?" gets asked, and an answer of nothing is not an answer;
 *   - it dissolves rather than blinking off, so the graph does not flicker
 *     while somebody scrolls through the threshold.
 *
 *   npm run smoke:graphlabels
 */

import {
  labelFade,
  labelFor,
  HUB_RADIUS,
  LABELS_EVERY,
  LABELS_FULL,
  LABELS_GONE,
} from "@/lib/graph-labels";

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

const node = (scale: number, radius: number) =>
  labelFor({ scale, radius, hover: false, focused: false, inNeighbourhood: false });

// ─── The reported bug ───────────────────────────────────────────────────

{
  // 0.15 is the zoom-out floor the panel allows.
  const hub = node(0.15, 9);
  check("AT MAXIMUM ZOOM-OUT A HUB HAS NO NAME", !hub.show, hub);
  check("…and neither does a small node", !node(0.15, 3).show);
  check(
    "…nor anywhere below the vanishing point",
    [0.15, 0.2, 0.3, 0.39].every((s) => !node(s, 9).show),
    [0.15, 0.2, 0.3, 0.39].map((s) => node(s, 9)),
  );
}

// ─── Reading distance ───────────────────────────────────────────────────

{
  check("a hub is named once you are close enough", node(0.6, 9).show);
  check(
    "…while a small node still waits",
    !node(0.6, 3).show,
    node(0.6, 3),
  );
  check(
    "and past the everything threshold, so is the small one",
    node(LABELS_EVERY + 0.05, 3).show,
  );
  check("a hub is bigger than the hub threshold, by definition", HUB_RADIUS > 0);
}

// ─── It dissolves, it does not blink ────────────────────────────────────

{
  check("nothing at the vanishing point", labelFade(LABELS_GONE) === 0);
  check("full at the reading point", labelFade(LABELS_FULL) === 1);
  const mid = labelFade((LABELS_GONE + LABELS_FULL) / 2);
  check("and half way between, half way visible", mid > 0.4 && mid < 0.6, mid);

  // Monotonic: no step, no dip, no flicker while the wheel turns.
  const fades = [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 1, 2].map(labelFade);
  check(
    "the ramp only ever rises",
    fades.every((f, i) => i === 0 || f >= fades[i - 1]),
    fades,
  );
  check("and never leaves 0…1", fades.every((f) => f >= 0 && f <= 1), fades);
  check("nonsense zoom is treated as far away", labelFade(NaN) === 0);
}

// ─── The escape hatches ─────────────────────────────────────────────────

{
  const hovered = labelFor({
    scale: 0.15,
    radius: 2,
    hover: true,
    focused: false,
    inNeighbourhood: false,
  });
  check("THE NODE UNDER THE POINTER IS NAMED AT ANY ZOOM", hovered.show, hovered);
  check("…and brightest of all", hovered.alpha > 0.9, hovered.alpha);

  const neighbour = labelFor({
    scale: 0.15,
    radius: 2,
    hover: false,
    focused: true,
    inNeighbourhood: true,
  });
  check("a focused node's neighbourhood keeps its names too", neighbour.show);

  const stranger = labelFor({
    scale: 2,
    radius: 20,
    hover: false,
    focused: true,
    inNeighbourhood: false,
  });
  check(
    "…and everything outside it loses them, however close you are",
    !stranger.show,
    stranger,
  );
}

console.log(
  failures ? `\n${failures} FAILED` : "\nFAR ENOUGH OUT, THE GRAPH IS A SHAPE",
);
process.exit(failures ? 1 : 0);
