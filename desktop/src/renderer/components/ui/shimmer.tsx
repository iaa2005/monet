import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Shimmer — animated gradient sweep for streaming / loading text.
 * Pairs with the `text-shimmer` utility defined in globals.css.
 */
function Shimmer({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="shimmer"
      className={cn("shimmer inline-block", className)}
      {...props}
    />
  )
}

export { Shimmer }
