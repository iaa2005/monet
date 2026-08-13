/**
 * The app's own icons, drawn in lucide's dialect.
 *
 * Lucide covers verbs — open, close, run, delete — and has nothing for the
 * things this app names: a language, a toolchain, an artifact. The alternative
 * is a brand icon set, and those are filled, multi-coloured and 16-box; dropped
 * into a row of lucide strokes they read as stickers pasted onto a drawing.
 *
 * So they are redrawn here to lucide's rules, which are strict and worth
 * keeping to the letter:
 *
 *   - a 24×24 box, and the artwork inside 2…22 — the outer 2px is where the
 *     stroke of a neighbouring icon's optical edge lives
 *   - stroke only, `currentColor`, width 2, round caps and joins
 *   - as few paths as will still be recognisable at 16px, which is the size
 *     these are actually used at
 *
 * The last rule is the one that does the work. A gopher has whiskers and a
 * gear has twelve teeth; at 16px both turn to porridge. What survives is the
 * silhouette: two big eyes and a muzzle, eight teeth, a cup with steam.
 *
 * Every icon takes SVGProps, so it drops into `icon={…}` anywhere a lucide
 * icon goes — see ObsidianIcon, which is the same shape and predates this file.
 */

import type { SVGProps } from "react";

/** The lucide frame. Everything below is just paths inside it. */
function Icon({
  children,
  ...props
}: SVGProps<SVGSVGElement> & { children: React.ReactNode }): JSX.Element {
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
      {children}
    </svg>
  );
}

/**
 * Artifacts: a half-disc, a circle and a plate — the user's own drawing.
 *
 * Not a file, not a folder, not a box: the panel holds whatever the model
 * produced, and every literal metaphor for that is already spoken for
 * elsewhere in the toolbar. Three primitives read as "things made".
 *
 * Rescaled from the original, which is stroked at 1. There the shapes sit
 * about 0.6 apart, which is composed at that weight and touching at lucide's
 * 2 — the diagonal ran straight into the plate's top corner. The plate moved
 * down and the half-disc up until the daylight was back.
 */
export function ArtifactIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9.7 2.8c-2.8 1.9-3.6 5.7-1.7 8.5L18.2 4.5c-1.9-2.8-5.7-3.6-8.5-1.7Z" />
      <circle cx="6.8" cy="17.3" r="3.7" />
      <rect x="14.8" y="9.8" width="6.4" height="12" rx="1.1" />
    </Icon>
  );
}

/**
 * C++: the C, and the two plusses that made it a different language.
 *
 * The plusses are large and far apart, both learned at 16px: small ones close
 * into dots, and a pair with only their own width between them fuses into a
 * single ‡. The C is as large as its opening allows — push the radius further
 * and the arc's left edge leaves the box.
 */
export function CppIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12.5 5.5a7 7 0 1 0 0 13" />
      <path d="M18.25 5v5.5M15.5 7.75h5.5" />
      <path d="M18.25 13.5v5.5M15.5 16.25h5.5" />
    </Icon>
  );
}

/**
 * Rust: Ferris.
 *
 * A gear with an R was the first attempt and it read as a ship's wheel — eight
 * short strokes around a circle are a sun, not teeth. The crab is what people
 * actually picture, and it survives 16px because its silhouette is one shape.
 * From the user's 16-box drawing, scaled 1.3 into this one.
 */
export function RustIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M21.75 13.95Q12 19.16 2.25 13.95l1.3-1.3l-1.3-2.6l2.6-.65V7.45h2.6l.65-2.6l1.95 1.3l1.95-2.6l1.95 2.6l1.95-1.3l.65 2.6h2.6V9.4l2.6.65l-1.3 2.6z" />
      <circle cx="8.75" cy="11.35" r="1.5" />
      <circle cx="15.25" cy="11.35" r="1.5" />
      <path d="M6.8 15.93c-.87.48-1.95 1.27-1.95 2.9s1.59 1.59 2.6 1.63v-2.6" />
      <path d="M17.2 15.9c.87.48 1.95 1.3 1.95 2.93s-1.59 1.59-2.6 1.63v-2.6" />
    </Icon>
  );
}

/**
 * Go: the G, with the speed lines.
 *
 * The gopher was the first attempt: at this size it lost its teeth and turned
 * into an owl, and a face among glyphs reads as a mascot rather than a label.
 * The wordmark's G still says Go at 16px.
 *
 * The G is scaled 1.45 from the user's 16-box drawing; the speed lines are
 * redrawn shorter rather than scaled with it. Scaling the pair together is
 * what left the icon small: the drawing is half again as wide as it is tall,
 * so the lines hit the edge while the G was still short of the top and bottom.
 */
export function GoIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m21.9 11.36l-7.03.7m7.03-.7a7.22 7.22 0 0 1-6.58 7.86a7.25 7.25 0 1 1 4.28-12.56l-2.47 2.67a3.63 3.63 0 0 0-6.06 2.99c.07.83.44 1.6 1 2.19c.36.39 1.45 1.2 2.58 1.19c1.16-.03 2.29-.36 3-1.17c0 0 1.16-1.39.99-2.73M6.5 9.1h-3M5 12H2M6.5 14.9H4.25" />
    </Icon>
  );
}

/**
 * Java: the cup.
 *
 * The user's, already drawn in a 24 box — for stroke 1.5. It is kept at 2 so
 * it carries the same weight as everything beside it; checked at 16px, where
 * the stacked curves of the cup still separate.
 */
export function JavaIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M6.175 10.333c-1.208.408-1.955.971-1.955 1.593c0 .848 1.389 1.587 3.44 1.971m0 0c-.762.385-1.217.874-1.217 1.407c0 1.243 2.487 2.252 5.555 2.252c.79 0 1.542-.067 2.223-.188m-6.56-3.471c.955.179 2.055.28 3.226.28c1.708 0 3.265-.216 4.445-.572m1.11-3.48c-1.411.416-3.379.675-5.555.675c-4.295 0-7.778-1.008-7.778-2.252c0-.96 2.077-1.78 5-2.104" />
      <path d="M22 19.07C22 20.688 17.523 22 12 22S2 20.688 2 19.07c0-1.15 1.707-2.146 5-2.626" />
      <path d="M18.76 8.788c4.214-1.094 4.816 5.468-1.205 7.656M17.558 2c-.74.123-2.133.815-1.778 2.593c.356 1.777-.148 2.716-.444 2.963M13.113 2c-.741.148-2.134.978-1.778 3.111s-.148 2.704-.444 3" />
    </Icon>
  );
}
