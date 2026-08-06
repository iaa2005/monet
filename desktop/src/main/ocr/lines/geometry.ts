/**
 * The bits of OpenCV a text detector needs, written out.
 *
 * A DB-style detector hands back a probability map, not boxes. Turning that
 * into the quadrilaterals people mean by "polygon" takes three classic
 * operations — connected components, minimum-area rectangle, and unclip —
 * and every one of them is one function in OpenCV and none of them are in
 * Node. They are short enough to write, and writing them beats a native
 * dependency that has to build on three platforms to draw a rectangle.
 *
 * Everything here is pure and takes plain arrays, so it can be checked
 * without a model, a GPU, or a picture.
 */

export type Point = [number, number];
/** Four corners, clockwise from the top-left-most. */
export type Quad = [Point, Point, Point, Point];

/**
 * Islands of "yes" in a binary mask.
 *
 * Iterative flood fill on a stack, not recursion: a page-sized text region
 * is tens of thousands of pixels and a recursive fill overflows on the
 * first real document.
 */
export function connectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  minPixels = 12,
): Point[][] {
  const seen = new Uint8Array(mask.length);
  const out: Point[][] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const pixels: Point[] = [];
    stack.push(start);
    seen[start] = 1;

    while (stack.length) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i / width) | 0;
      pixels.push([x, y]);
      // Four-connected: diagonal joins merge two lines of text that touch
      // at a corner, which is exactly what must not happen here.
      if (x > 0 && mask[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), stack.push(i - 1);
      if (x + 1 < width && mask[i + 1] && !seen[i + 1])
        (seen[i + 1] = 1), stack.push(i + 1);
      if (y > 0 && mask[i - width] && !seen[i - width])
        (seen[i - width] = 1), stack.push(i - width);
      if (y + 1 < height && mask[i + width] && !seen[i + width])
        (seen[i + width] = 1), stack.push(i + width);
    }
    if (pixels.length >= minPixels) out.push(pixels);
  }
  return out;
}

/** Convex hull, counter-clockwise (Andrew's monotone chain). */
export function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Point, a: Point, b: Point): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const build = (pts: Point[]): Point[] => {
    const half: Point[] = [];
    for (const p of pts) {
      while (half.length >= 2 && cross(half[half.length - 2], half[half.length - 1], p) <= 0)
        half.pop();
      half.push(p);
    }
    half.pop();
    return half;
  };

  return [...build(sorted), ...build([...sorted].reverse())];
}

/**
 * The smallest rectangle around a shape, at any angle.
 *
 * Rotating calipers on the hull: the minimum-area rectangle always has a
 * side flush with one hull edge, so trying each edge as the axis and
 * keeping the best is exact, not an approximation.
 *
 * This is what makes a SLANTED line of text come back as a slanted
 * quadrilateral instead of the upright box around it — which on a skewed
 * scan is most of the surrounding paragraph.
 */
export function minAreaRect(points: Point[]): { quad: Quad; angle: number } {
  const hull = convexHull(points);
  if (hull.length < 3) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const x1 = Math.min(...xs);
    const x2 = Math.max(...xs);
    const y1 = Math.min(...ys);
    const y2 = Math.max(...ys);
    return {
      quad: [
        [x1, y1],
        [x2, y1],
        [x2, y2],
        [x1, y2],
      ],
      angle: 0,
    };
  }

  let best: { quad: Quad; angle: number; area: number } | null = null;

  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const ux = dx / len;
    const uy = dy / len;

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy;
      const v = -p[0] * uy + p[1] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (best && area >= best.area) continue;

    const corner = (u: number, v: number): Point => [
      u * ux - v * uy,
      u * uy + v * ux,
    ];
    best = {
      area,
      angle: Math.atan2(uy, ux),
      quad: [
        corner(minU, minV),
        corner(maxU, minV),
        corner(maxU, maxV),
        corner(minU, maxV),
      ],
    };
  }

  const found = best!;
  return { quad: orderClockwise(found.quad), angle: normaliseAngle(found.angle) };
}

/** An angle for a LINE, so ±180° and ±90° flips are the same line. */
export function normaliseAngle(radians: number): number {
  let deg = (radians * 180) / Math.PI;
  while (deg <= -90) deg += 180;
  while (deg > 90) deg -= 180;
  return deg;
}

/** Corners clockwise, starting from the top-left — the order every
 * downstream crop assumes. */
export function orderClockwise(quad: Quad): Quad {
  const cx = quad.reduce((n, p) => n + p[0], 0) / 4;
  const cy = quad.reduce((n, p) => n + p[1], 0) / 4;
  const sorted = [...quad].sort(
    (a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx),
  );
  // Start at whichever corner is closest to the origin corner of the box.
  let startAt = 0;
  let bestScore = Infinity;
  sorted.forEach((p, i) => {
    const score = p[0] + p[1];
    if (score < bestScore) {
      bestScore = score;
      startAt = i;
    }
  });
  return [
    sorted[startAt],
    sorted[(startAt + 1) % 4],
    sorted[(startAt + 2) % 4],
    sorted[(startAt + 3) % 4],
  ];
}

/**
 * Grow a quadrilateral outwards, the way DB's post-processing does.
 *
 * The detector is trained to predict a SHRUNK version of each text region —
 * that is how it keeps neighbouring lines apart — so the raw shape is
 * inside the ink. Without this, every crop clips its own letters.
 *
 * The offset is Vatti's: area × ratio / perimeter, applied along each
 * corner's outward diagonal.
 */
export function unclip(quad: Quad, ratio = 1.5): Quad {
  const area = Math.abs(polygonArea(quad));
  const perimeter = quadPerimeter(quad);
  if (perimeter < 1e-9) return quad;
  const distance = (area * ratio) / perimeter;

  const cx = quad.reduce((n, p) => n + p[0], 0) / 4;
  const cy = quad.reduce((n, p) => n + p[1], 0) / 4;
  return quad.map((p) => {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [p[0] + (dx / len) * distance, p[1] + (dy / len) * distance] as Point;
  }) as Quad;
}

export function polygonArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function quadPerimeter(quad: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    sum += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return sum;
}

/** The upright box that contains a quadrilateral. */
export function boundingBox(quad: Quad): [number, number, number, number] {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  return [
    Math.round(Math.min(...xs)),
    Math.round(Math.min(...ys)),
    Math.round(Math.max(...xs)),
    Math.round(Math.max(...ys)),
  ];
}

/**
 * How far the page is off level, from the lines on it.
 *
 * The MEDIAN of the line angles, weighted by nothing: a page has many lines
 * and a handful of them will be a figure caption at an angle or a detector
 * mistake, and a mean would follow those. Short lines are dropped first —
 * a two-word line has an unreliable angle by construction.
 */
export function pageSkew(
  lines: { quad: Quad; angle: number }[],
  minLength = 40,
): number {
  const angles = lines
    .filter((l) => {
      const w = Math.hypot(l.quad[1][0] - l.quad[0][0], l.quad[1][1] - l.quad[0][1]);
      return w >= minLength;
    })
    .map((l) => l.angle)
    .sort((a, b) => a - b);
  if (angles.length === 0) return 0;
  const mid = Math.floor(angles.length / 2);
  return angles.length % 2 ? angles[mid] : (angles[mid - 1] + angles[mid]) / 2;
}
