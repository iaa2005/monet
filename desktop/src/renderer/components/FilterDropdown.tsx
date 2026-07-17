import { useState, useRef, useEffect, useCallback } from "react";
import { Filter, Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

type FilterOption = {
  label: string;
  value: string;
};

type Submenu = {
  label: string;
  options: FilterOption[];
  selected: string;
  onSelect: (value: string) => void;
};

type Filters = {
  status: string;
  activity: string;
  group: string;
  sort: string;
  sortDir: "asc" | "desc";
};

const STATUS_OPTS: FilterOption[] = [
  { label: "Active", value: "active" },
  { label: "Archived", value: "archived" },
  { label: "All", value: "all" },
];
const ACTIVITY_OPTS: FilterOption[] = [
  { label: "1d", value: "1d" },
  { label: "3d", value: "3d" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "All", value: "all" },
];
// Only groupings that EXIST. This used to list "PR status" and "Custom
// groups" — features this app has never had; options that select nothing are
// the UI equivalent of a guessed endpoint.
const GROUP_OPTS: FilterOption[] = [
  { label: "Date", value: "date" },
  { label: "State", value: "state" },
  { label: "None", value: "none" },
];
const SORT_OPTS: FilterOption[] = [
  { label: "Recency", value: "recency" },
  { label: "Name", value: "name" },
  { label: "Activity", value: "activity" },
];

interface FilterDropdownProps {
  filters: Filters;
  onChange: (f: Filters) => void;
}

export function FilterDropdown({
  filters,
  onChange,
}: FilterDropdownProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [subTop, setSubTop] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setHovered(null);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const handleHover = useCallback(
    (label: string) => (e: React.MouseEvent<HTMLButtonElement>) => {
      setHovered(label);
      if (menuRef.current) {
        const btn = e.currentTarget;
        const menuRect = menuRef.current.getBoundingClientRect();
        const btnRect = btn.getBoundingClientRect();
        setSubTop(btnRect.top - menuRect.top);
      }
    },
    [],
  );

  const setStatus = (v: string) => onChange({ ...filters, status: v });
  const setActivity = (v: string) => onChange({ ...filters, activity: v });
  const setGroup = (v: string) => onChange({ ...filters, group: v });
  const setSort = (v: string) => {
    if (filters.sort === v) {
      onChange({
        ...filters,
        sortDir: filters.sortDir === "asc" ? "desc" : "asc",
      });
    } else {
      onChange({ ...filters, sort: v, sortDir: "desc" });
    }
  };

  const subs: Submenu[] = [
    {
      label: "Status",
      options: STATUS_OPTS,
      selected: filters.status,
      onSelect: setStatus,
    },
    {
      label: "Last activity",
      options: ACTIVITY_OPTS,
      selected: filters.activity,
      onSelect: setActivity,
    },
    {
      label: "Group by",
      options: GROUP_OPTS,
      selected: filters.group,
      onSelect: setGroup,
    },
    {
      label: "Sort by",
      options: SORT_OPTS,
      selected: filters.sort,
      onSelect: setSort,
    },
  ];

  const hasActiveFilter =
    filters.status !== "all" ||
    filters.activity !== "all" ||
    filters.group !== "none" ||
    filters.sort !== "recency" ||
    filters.sortDir !== "desc";

  const activeSub = subs.find((s) => s.label === hovered);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          setOpen(!open);
          setHovered(null);
        }}
        className="relative rounded p-0.5 text-muted-foreground hover:text-foreground"
      >
        <Filter size={12} />
        {hasActiveFilter && (
          <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-link" />
        )}
      </button>
      {open && (
        <div
          ref={menuRef}
          className="absolute right-0 top-6 z-50 w-40 rounded-lg border border-border bg-popover p-1 shadow-md text-xs"
        >
          {subs.map((s) => (
            <button
              key={s.label}
              onMouseEnter={handleHover(s.label)}
              onClick={handleHover(s.label)}
              className={cn(
                "flex w-full items-center justify-between rounded px-2 py-1.5 transition-colors hover:bg-accent hover:text-foreground",
                hovered === s.label && "bg-accent text-foreground",
              )}
            >
              <span>{s.label}</span>
              <span className="flex items-center gap-1 text-muted-foreground">
                {(() => {
                  const opt = s.options.find((o) => o.value === s.selected);
                  const label = opt ? opt.label : s.selected;
                  if (s.label === "Sort by") {
                    return (
                      <>
                        {label} {filters.sortDir === "asc" ? "↑" : "↓"}
                      </>
                    );
                  }
                  return label;
                })()}
                <ChevronRight size={10} />
              </span>
            </button>
          ))}
          {/* Flyout submenu — separate card, anchored inside menu */}
          {activeSub && (
            <div
              className="absolute left-full z-50 ml-1 w-36 rounded-lg border border-border bg-popover p-1 shadow-md text-xs"
              style={{ top: subTop }}
            >
              {activeSub.options.map((o) => (
                <button
                  key={o.value}
                  onClick={() => {
                    if (o.value !== "divider") {
                      activeSub.onSelect(o.value);
                    }
                  }}
                  className={cn(
                    "flex w-full items-center justify-between rounded px-2 py-1.5 transition-colors hover:bg-accent hover:text-foreground",
                    o.value === "divider" && "pointer-events-none",
                  )}
                >
                  {o.value === "divider" ? (
                    <span className="w-full border-t border-border my-0.5" />
                  ) : (
                    <>
                      <span>{o.label}</span>
                      {activeSub.label === "Sort by" &&
                      activeSub.selected === o.value ? (
                        <span className="text-muted-foreground">
                          {filters.sortDir === "asc" ? "↑" : "↓"}
                        </span>
                      ) : activeSub.selected === o.value ? (
                        <Check size={12} />
                      ) : null}
                    </>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
