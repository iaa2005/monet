/**
 * An agent's mark, or its first letter.
 *
 * The letter is not a placeholder to be embarrassed about: VS Code publishes no
 * vector mark, and a repository can name a folder for an agent that did not
 * exist when this file was written. Both must show something.
 */

import { cn } from "@/lib/utils";
import { AGENT_ICON_PATHS } from "./agent-icons";

export function AgentIcon({
  id,
  label,
  size = 16,
  className,
}: {
  id: string;
  label: string;
  size?: number;
  className?: string;
}): JSX.Element {
  const paths = AGENT_ICON_PATHS[id];
  if (!paths?.length)
    return (
      <span
        aria-hidden
        style={{ width: size, height: size, fontSize: size * 0.62 }}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-[3px] border border-current/25 font-semibold uppercase leading-none",
          className,
        )}
      >
        {label.replace(/[^a-z0-9]/gi, "").charAt(0) || "?"}
      </span>
    );
  return (
    <svg
      aria-hidden
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
    >
      {paths.map((d) => (
        // currentColor, so the mark takes the button's own colour in either theme
        // rather than staying white on a black tile.
        <path key={d.slice(0, 24)} d={d} fill="currentColor" />
      ))}
    </svg>
  );
}
