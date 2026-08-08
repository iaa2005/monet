/**
 * When a graph node deserves its name.
 *
 * The labels are drawn at a constant SCREEN size — 9.5px whatever the zoom —
 * which is right when you are reading and wrong when you are looking at the
 * whole vault: zooming out does not shrink the names, it only brings them
 * closer together, so past a point every label overlaps every other and the
 * graph reads as a smear of text over a cluster of dots. Reported at maximum
 * zoom-out, where four hub labels sat on top of each other.
 *
 * So the names fade with distance, and are gone before they can collide.
 * Two exceptions, both deliberate: the node under the pointer and — when one
 * is focused — its neighbourhood keep their names at any zoom, because that
 * is the one moment you are asking "what is this?" rather than "what shape
 * is this?".
 *
 * Pure, so the thresholds are pinned by a probe rather than by squinting at
 * a canvas.
 */

/** Below this the graph is a shape, not a document: no names at all. */
export const LABELS_GONE = 0.4;
/** At and above this, names are at full strength. */
export const LABELS_FULL = 0.55;
/** Above this every node is named; between, only the hubs. */
export const LABELS_EVERY = 0.9;
/** A node this big is a hub — named before the small ones are. */
export const HUB_RADIUS = 6;

/**
 * How strongly labels show at this zoom: 0 = not at all, 1 = fully.
 *
 * A ramp rather than a switch, so zooming out dissolves the names instead
 * of blinking them off a frame before they would have overlapped.
 */
export function labelFade(scale: number): number {
  if (!Number.isFinite(scale) || scale <= LABELS_GONE) return 0;
  if (scale >= LABELS_FULL) return 1;
  return (scale - LABELS_GONE) / (LABELS_FULL - LABELS_GONE);
}

export interface LabelInput {
  scale: number;
  /** The node's drawn radius — hubs earn their name sooner. */
  radius: number;
  /** The pointer is on this node. */
  hover: boolean;
  /** Something is focused; is this node in its neighbourhood? */
  focused: boolean;
  inNeighbourhood: boolean;
}

/** Whether to draw this node's name, and at what strength. */
export function labelFor(input: LabelInput): { show: boolean; alpha: number } {
  const { scale, radius, hover, focused, inNeighbourhood } = input;
  // Asking about one node beats every distance rule: this is the moment the
  // name is the whole point.
  if (hover) return { show: true, alpha: 0.95 };
  if (focused)
    return inNeighbourhood ? { show: true, alpha: 0.6 } : { show: false, alpha: 0 };

  const fade = labelFade(scale);
  if (fade === 0) return { show: false, alpha: 0 };
  const worthNaming = scale > LABELS_EVERY || radius > HUB_RADIUS;
  if (!worthNaming) return { show: false, alpha: 0 };
  return { show: true, alpha: 0.6 * fade };
}
