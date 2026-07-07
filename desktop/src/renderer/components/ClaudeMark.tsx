/** Claude-style asterisk / sunburst mark. Inherits color via `currentColor`. */
export function ClaudeMark({
  className,
}: {
  className?: string;
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      aria-hidden="true"
      fill="none"
    >
      <g stroke="currentColor" strokeWidth="9" strokeLinecap="round">
        <line x1="50" y1="16" x2="50" y2="84" />
        <line x1="16" y1="50" x2="84" y2="50" />
        <line x1="26" y1="26" x2="74" y2="74" />
        <line x1="74" y1="26" x2="26" y2="74" />
      </g>
    </svg>
  );
}
