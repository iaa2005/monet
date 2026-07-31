/**
 * One palette for a selected element, used in two places at once.
 *
 * The point of colouring at all is that the box drawn around a thing on the
 * page and the chip standing for it in the message are recognisably the same
 * thing. That only works if both sides compute the colour from the same number
 * — so the palette lives here, and the overlay injected into the page gets it
 * inlined from this file rather than keeping a copy that drifts.
 *
 * Hues, not hex: a chip needs a readable foreground on a tinted background in
 * two themes, and a box on an unknown page needs a saturated stroke. Those are
 * four different colours from one hue, and hard-coding all four per tone is how
 * a palette ends up almost-consistent.
 */

/** Distinct enough to tell apart at a glance, in this order. */
export const TONE_HUES = [211, 145, 275, 32, 340, 190] as const;

export function toneHue(index: number): number {
  return TONE_HUES[Math.abs(index) % TONE_HUES.length]!;
}

export interface ChipColors {
  fg: string;
  bg: string;
  ring: string;
}

/**
 * Chip colours for a hue.
 *
 * Dark themes need a lighter, less saturated foreground — the same 45%
 * lightness that reads as "blue" on white reads as "almost black" on #1b1b1c.
 */
export function chipColors(index: number, dark: boolean): ChipColors {
  const h = toneHue(index);
  return dark
    ? {
        fg: `hsl(${h} 85% 72%)`,
        bg: `hsl(${h} 70% 60% / 0.16)`,
        ring: `hsl(${h} 70% 62% / 0.35)`,
      }
    : {
        fg: `hsl(${h} 78% 42%)`,
        bg: `hsl(${h} 85% 55% / 0.12)`,
        ring: `hsl(${h} 70% 45% / 0.28)`,
      };
}

export interface BoxColors {
  border: string;
  fill: string;
  label: string;
}

/**
 * Box colours for the overlay drawn on the page.
 *
 * Saturated and opaque on the stroke, because it lands on whatever the page
 * happens to be — a tint that reads clearly on white disappears on a dark hero
 * image, and the whole job of the box is to be findable.
 */
export function boxColors(index: number): BoxColors {
  const h = toneHue(index);
  return {
    border: `hsl(${h} 90% 52%)`,
    fill: `hsl(${h} 90% 52% / 0.14)`,
    label: `hsl(${h} 90% 45%)`,
  };
}

/**
 * The tone an element gets when only its NAME is known.
 *
 * A selection carries its tone, but text does not: a draft restored from
 * storage, or a message re-read after a reload, has the label and nothing else.
 * Hashing keeps a given element the same colour across those, instead of
 * reshuffling every chip in the message.
 */
export function toneForLabel(label: string): number {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) | 0;
  return Math.abs(h);
}
