/**
 * Directory primitives — the card, the chips and the two dropdowns every
 * section in the Directory reuses. Nothing here knows what a skill, a
 * connector or an MCP server is.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Plug, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

export function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/** Inline a service's own SVG. Safe: icons are normalized (namespaced ids)
 * before they reach the renderer. */
export function ServiceIcon({
  svg,
  className,
  dim,
}: {
  svg?: string;
  className?: string;
  dim?: boolean;
}): JSX.Element {
  if (!svg)
    return <Plug className={cn("shrink-0 text-muted-foreground", className)} />;
  return (
    <span
      role="img"
      aria-hidden="true"
      className={cn(
        "inline-block shrink-0 [&>svg]:size-full",
        dim && "opacity-40 grayscale",
        className,
      )}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// ─── Dropdown ──────────────────────────────────────────────────────────────

export interface PickerOption {
  label: string;
  value: string;
}

/** The "Filter by" / "Sort by" control: a label that opens a checked list. */
export function Picker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: PickerOption[];
  onChange: (v: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const current = options.find((o) => o.value === value);
  const isDefault = options[0]?.value === value;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]",
          !isDefault && "border-foreground/30",
        )}
      >
        {isDefault ? label : (current?.label ?? label)}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-48 rounded-xl border border-border bg-popover p-1 shadow-lg">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
            >
              {o.label}
              {o.value === value && <Check className="size-3.5" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Chips ─────────────────────────────────────────────────────────────────

/** A source filter chip. `onRemove` adds the ✕ that deletes the source. */
export function Chip({
  label,
  active,
  onClick,
  onRemove,
  title,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  onRemove?: () => void;
  title?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        "group inline-flex shrink-0 items-center gap-1 rounded-lg border text-[13px] font-medium transition-colors",
        active
          ? "border-transparent bg-foreground text-background"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        title={title ?? label}
        className="max-w-[22ch] truncate py-1.5 pl-3 pr-1.5"
      >
        {label}
      </button>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          title="Remove this source"
          className={cn(
            "mr-1.5 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100",
            active ? "hover:bg-white/20" : "hover:bg-black/10 dark:hover:bg-white/10",
          )}
        >
          <X className="size-3" />
        </button>
      ) : (
        <span className="pr-1.5" />
      )}
    </span>
  );
}

// ─── Card ──────────────────────────────────────────────────────────────────

/**
 * One catalog entry. Title, a provenance line, the description, and an action
 * slot in the top-right — the same shape whatever the section is showing.
 */
export function DirCard({
  title,
  meta,
  description,
  icon,
  action,
  onClick,
  dim,
}: {
  title: ReactNode;
  meta?: ReactNode;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  onClick?: () => void;
  dim?: boolean;
}): JSX.Element {
  return (
    <div
      onClick={onClick}
      className={cn(
        "flex min-h-[7.5rem] flex-col rounded-2xl border border-border bg-card/60 p-4 transition-colors",
        onClick && "cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.03]",
        dim && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2.5">
        {icon}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-medium leading-tight">
            {title}
          </div>
          {meta && (
            <div className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
              {meta}
            </div>
          )}
        </div>
        {/* flex, because a card can offer more than one action — reading the
            source before installing it, for one. */}
        {action && (
          <div className="ml-1 flex shrink-0 items-center gap-0.5">{action}</div>
        )}
      </div>
      {description && (
        <p className="mt-2.5 line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );
}

/** Round icon button in a card's corner — install, remove, configure. */
export function CardAction({
  icon: Icon,
  title,
  onClick,
  busy,
  variant = "default",
  disabled,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  onClick: () => void;
  busy?: boolean;
  variant?: "default" | "danger" | "solid";
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={busy || disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex size-7 items-center justify-center rounded-lg transition-colors disabled:opacity-40",
        variant === "danger"
          ? "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          : variant === "solid"
            ? "bg-foreground text-background hover:opacity-90"
            : "text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]",
      )}
    >
      {busy ? (
        <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        <Icon className="size-4" />
      )}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="col-span-full py-16 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/** Case-insensitive "does this entry match what was typed" across fields. */
export function matches(query: string, ...fields: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => f?.toLowerCase().includes(q));
}
