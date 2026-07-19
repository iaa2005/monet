/**
 * Modality icons — the shared visual language for what a model accepts.
 *
 * text = blue "T", audio = violet, file = rose, image = green,
 * video = orange (per design request). Used as read-only badges in the
 * composer's model picker and as toggles in Provider Settings.
 */

import {
  AudioLines,
  Image as ImageIcon,
  Paperclip,
  Type,
  Video,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Modality } from "@/stores/providerStore";

export const MODALITY_META: {
  id: Modality;
  label: string;
  color: string;
  Icon: LucideIcon;
}[] = [
  { id: "text", label: "Text", color: "text-sky-500", Icon: Type },
  { id: "image", label: "Images", color: "text-emerald-500", Icon: ImageIcon },
  { id: "audio", label: "Audio", color: "text-violet-500", Icon: AudioLines },
  { id: "file", label: "Files", color: "text-rose-500", Icon: Paperclip },
  { id: "video", label: "Video", color: "text-orange-500", Icon: Video },
];

/** Read-only row of colored icons for the modalities a model accepts.
 *  When `fixedSlots` is true, renders ALL modality icons in a fixed order,
 *  dimming the ones not present — so icons of the same type line up in a table. */
export function ModalityBadges({
  modalities,
  className,
  fixedSlots = false,
}: {
  modalities?: Modality[];
  className?: string;
  fixedSlots?: boolean;
}): JSX.Element {
  const list = modalities?.length ? modalities : (["text"] as Modality[]);
  const items = fixedSlots
    ? MODALITY_META
    : MODALITY_META.filter((m) => list.includes(m.id));
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {items.map((m) => {
        const on = list.includes(m.id);
        return (
          <m.Icon
            key={m.id}
            className={cn("size-4", on ? m.color : "text-muted-foreground/20")}
          />
        );
      })}
    </span>
  );
}

/** Click-to-toggle icon row used in Provider Settings. */
export function ModalityToggles({
  value,
  onChange,
}: {
  value?: Modality[];
  onChange: (next: Modality[]) => void;
}): JSX.Element {
  const list = value?.length ? value : (["text"] as Modality[]);
  const toggle = (id: Modality): void => {
    const next = list.includes(id)
      ? list.filter((x) => x !== id)
      : [...list, id];
    // A model that accepts nothing makes no sense — keep at least text.
    onChange(next.length > 0 ? next : ["text"]);
  };
  return (
    <div className="flex items-center gap-1">
      {MODALITY_META.map((m) => {
        const on = list.includes(m.id);
        return (
          <button
            key={m.id}
            type="button"
            title={`${m.label} — ${on ? "accepted" : "not accepted"}`}
            onClick={() => toggle(m.id)}
            className={cn(
              "flex size-6 items-center justify-center rounded-md border transition-colors",
              on
                ? cn("border-transparent bg-black/[0.05] dark:bg-white/[0.08]", m.color)
                : "border-transparent text-muted-foreground/40 hover:text-muted-foreground",
            )}
          >
            <m.Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
