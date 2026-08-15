/**
 * The Directory — one store for everything the app can be extended with.
 *
 * Skills, connectors and MCP servers used to live in three separate places
 * with three different install flows. They are the same act: browse a
 * catalogue, read what it will do, add it. This is that one window; each
 * section still owns its own sources, filters and install path.
 */

import { useState } from "react";
import { Blocks, ScrollText, Search, Server, Store } from "@/components/icons/hg";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import { SkillsSection } from "./SkillsSection";
import { ConnectorsSection } from "./ConnectorsSection";
import { McpSection } from "./McpSection";

export type DirectorySection = "skills" | "connectors" | "mcp";

const SECTIONS: {
  id: DirectorySection;
  label: string;
  icon: typeof ScrollText;
  placeholder: string;
}[] = [
  {
    id: "skills",
    label: "Skills",
    icon: ScrollText,
    placeholder: "Search skills…",
  },
  {
    id: "connectors",
    label: "Connectors",
    icon: Blocks,
    placeholder: "Search connectors…",
  },
  {
    id: "mcp",
    label: "MCP Servers",
    icon: Server,
    placeholder: "Search the MCP registry…",
  },
];

export function DirectoryModal({
  initialSection = "skills",
  onClose,
}: {
  initialSection?: DirectorySection;
  onClose: () => void;
}): JSX.Element {
  const [section, setSection] = useState<DirectorySection>(initialSection);
  // Per-section queries: the MCP box is a live registry query, so carrying a
  // skill search into it would fire a pointless request on every switch.
  const [queries, setQueries] = useState<Record<DirectorySection, string>>({
    skills: "",
    connectors: "",
    mcp: "",
  });
  const query = queries[section];
  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <Modal open onClose={onClose} bare className="h-[85vh] max-w-5xl">
      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
        <aside className="flex w-52 shrink-0 flex-col border-r border-border px-3 py-5">
          <h1 className="px-3 font-display text-[26px] leading-none tracking-tight">
            Directory
          </h1>
          <nav className="mt-7 space-y-0.5">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSection(s.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors",
                  section === s.id
                    ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <s.icon className="size-4 shrink-0" />
                {s.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="shrink-0 px-6 pb-4 pt-5 pr-14">
            <div className="flex items-center gap-2 rounded-xl border border-border bg-black/[0.02] px-3 py-2 focus-within:border-foreground/30 dark:bg-white/[0.03]">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) =>
                  setQueries((q) => ({ ...q, [section]: e.target.value }))
                }
                placeholder={current.placeholder}
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQueries((q) => ({ ...q, [section]: "" }))}
                  className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            {section === "skills" && <SkillsSection query={query} />}
            {section === "connectors" && <ConnectorsSection query={query} />}
            {section === "mcp" && <McpSection query={query} />}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The dashed "go to the store" button. It sits in Settings wherever the thing
 * it installs is managed, and opens the Directory on that section.
 */
export function DirectoryButton({
  section,
  title,
  subtitle,
  onChanged,
}: {
  section: DirectorySection;
  title: string;
  subtitle: string;
  onChanged?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-3 rounded-xl border border-dashed border-border p-3 text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
      >
        <Store className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>
        </div>
      </button>
      {open && (
        <DirectoryModal
          initialSection={section}
          onClose={() => {
            setOpen(false);
            onChanged?.();
          }}
        />
      )}
    </>
  );
}
