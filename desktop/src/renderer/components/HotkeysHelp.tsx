/**
 * The keyboard cheatsheet (Ctrl+/ / ⌘/) — rendered FROM the keymap, so it
 * cannot drift from what the keys actually do.
 */

import { Modal } from "@/components/ui/modal";
import { comboLabel, type HotkeyDef } from "@/lib/hotkeys";

export function HotkeysHelp({
  open,
  onClose,
  hotkeys,
}: {
  open: boolean;
  onClose: () => void;
  hotkeys: HotkeyDef[];
}): JSX.Element | null {
  const sections = new Map<string, HotkeyDef[]>();
  for (const h of hotkeys) {
    if (h.hidden) continue;
    const list = sections.get(h.section) ?? [];
    list.push(h);
    sections.set(h.section, list);
  }

  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" className="w-[26rem]">
      <div className="flex flex-col gap-4">
        {[...sections.entries()].map(([section, defs]) => (
          <div key={section}>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">
              {section}
            </div>
            <div className="flex flex-col">
              {defs.map((h) => (
                <div
                  key={h.combo}
                  className="flex items-center justify-between border-b border-border py-1.5 text-sm last:border-b-0"
                >
                  <span>{h.label}</span>
                  <kbd className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {comboLabel(h.combo)}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
