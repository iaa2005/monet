/**
 * Tooltip — the shadcn/Claude Code shape: an ink-on-paper-inverted chip that
 * names the control and, when the control has a hotkey, shows it as quiet
 * mono text beside the name.
 *
 * Built on Radix so it behaves (portals over the dock, flips at edges,
 * closes on press). `Hint` is the everyday wrapper: hand it a label and an
 * optional combo, it wires the whole primitive — because nineteen buttons
 * each assembling four Radix parts is how tooltips end up inconsistent.
 */

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

function TooltipProvider(
  props: React.ComponentProps<typeof TooltipPrimitive.Provider>,
): JSX.Element {
  return <TooltipPrimitive.Provider delayDuration={350} {...props} />;
}

function Tooltip(
  props: React.ComponentProps<typeof TooltipPrimitive.Root>,
): JSX.Element {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root {...props} />
    </TooltipProvider>
  );
}

const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>): JSX.Element {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-[70] flex select-none items-center gap-1.5 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-md",
          "animate-in fade-in-0 zoom-in-95",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

/** A tooltip in one line: `<Hint label="Browser" combo="Ctrl+⇧+B">…</Hint>`.
 * The combo renders as quiet mono text, the Claude Code way. */
function Hint({
  label,
  combo,
  side,
  children,
}: {
  label: string;
  combo?: string;
  side?: "top" | "bottom" | "left" | "right";
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        {combo && (
          <span className="font-mono text-[10px] font-normal text-background/60">
            {combo}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, Hint };
