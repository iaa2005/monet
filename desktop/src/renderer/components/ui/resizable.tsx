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
        "group/resize relative w-px shrink-0 bg-border transition-colors",
        "after:absolute after:inset-y-0 after:-left-[3px] after:z-10 after:w-[7px] after:content-['']",
        "hover:bg-ring/60 data-[resize-handle-state=drag]:bg-ring",
        "focus-visible:outline-none",
        "data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full",
        "data-[panel-group-direction=vertical]:after:inset-x-0 data-[panel-group-direction=vertical]:after:-top-[3px] data-[panel-group-direction=vertical]:after:h-[7px] data-[panel-group-direction=vertical]:after:w-full",
        className,
      )}
      {...props}
    />
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
