/**
 * The overlay layer is <body> — never the panel that opened it.
 *
 * dockview puts its sashes at z-index 99 and its drag overlays at 999, and
 * dock.css traps those in a stacking context of their own (`isolation`) so an
 * app modal can cover the dock. That works for a dialog rendered by App, and
 * fails for every dialog rendered from INSIDE the dock — and most of them are:
 * the chat column is portalled into the dock's main panel, the file tree IS a
 * panel. Their dialogs are born inside the isolated context, where z-50 is
 * measured against the library's 99.
 *
 * What that looked like: the little resize pill of every seam drawn ON TOP of
 * the dialog, bright against the dimmed backdrop — and still grabbing the
 * mouse, so a divider could be dragged straight through an open modal and a
 * click near the seam never reached the buttons under it.
 *
 * Rendering into <body> puts the overlay outside the dock's context entirely:
 * z-50 means what it says, the backdrop covers the whole window (sidebar
 * included), and nothing inside the dock can be above it or steal a click
 * from it.
 */

import { createPortal } from "react-dom";
import type { ReactNode } from "react";

export function Portal({ children }: { children: ReactNode }): JSX.Element {
  return createPortal(children, document.body);
}
