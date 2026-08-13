import * as React from "react";
import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "@/lib/utils";

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>): JSX.Element {
  return (
    <ResizablePrimitive.PanelGroup
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

const ResizablePanel = ResizablePrimitive.Panel;

/**
 * The divider IS the border.
 *
 * One shared hairline between two panes, and that same hairline is what you
 * grab — no gap, no floating grip. The line itself is 1px (the element's own
 * background); the HIT area is widened to 7px with a transparent ::after
 * that overhangs both sides, because a 1px grab target is a coordination
 * test, not an interface. Hovering (or dragging) tints the line so it is
 * clear the border is a control.
 *
 * `withHandle` is accepted and ignored — the line is the handle now, and
 * every call site said `withHandle` when it meant "resizable here".
 */
function ResizableHandle({
  withHandle: _withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean;
}): JSX.Element {
  return (
    <ResizablePrimitive.PanelResizeHandle
      data-slot="resizable-handle"
      className={cn(
        // The gutter between two cards is 8px of background — the same 8px the
        // body pads the window with — so the panes read as separated by air
        // rather than divided by a rule.
        //
        // What you SEE is a short pill at the middle of the seam; what you can
        // GRAB is the whole seam. That is two layers: ::after runs the full
        // length and is invisible, ::before is the pill and takes no pointer
        // events. Making the pill itself the target would mean aiming at 32px
        // of a thousand-pixel edge.
        "group/resize relative w-0 shrink-0",
        "after:absolute after:inset-y-0 after:left-1/2 after:z-10 after:w-2 after:-translate-x-1/2 after:content-['']",
        "before:pointer-events-none before:absolute before:left-1/2 before:top-1/2 before:z-20 before:h-8 before:w-[3px] before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:bg-border before:transition-colors before:content-['']",
        "hover:before:bg-ring/60 data-[resize-handle-state=drag]:before:bg-ring",
        "focus-visible:outline-none",
        "data-[panel-group-direction=vertical]:h-0 data-[panel-group-direction=vertical]:w-full",
        "data-[panel-group-direction=vertical]:after:inset-x-0 data-[panel-group-direction=vertical]:after:inset-y-auto data-[panel-group-direction=vertical]:after:top-1/2 data-[panel-group-direction=vertical]:after:h-2 data-[panel-group-direction=vertical]:after:w-auto data-[panel-group-direction=vertical]:after:-translate-y-1/2 data-[panel-group-direction=vertical]:after:translate-x-0",
        "data-[panel-group-direction=vertical]:before:h-[3px] data-[panel-group-direction=vertical]:before:w-8",
        className,
      )}
      {...props}
    />
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
