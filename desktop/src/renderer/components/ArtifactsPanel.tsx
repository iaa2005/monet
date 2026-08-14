/**
 * Artifacts panel — the current chat's files, in three groups:
 *   Artifacts — files the model DELIVERED to the user (DeliverFiles,
 *               screenshots, connector downloads). The showcase.
 *   All files — everything else the sandbox wrote: intermediates, data files,
 *               scripts. Collapsed by default — reachable, not on display.
 *   Content   — input the user attached to their messages.
 *
 * Files live on disk (<dataDir>/artifacts/<sessionId>/…); image previews are
 * re-read lazily from the artifact path, so they survive chat switches and
 * restarts. Clicking an item opens it with the OS default app.
 */

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  groupVersions,
  useSessionArtifacts,
  type ArtifactItem,
} from "@/lib/sessionArtifacts";
import {
  DownloadAllButton,
  FileCard,
  FileTile,
} from "@/components/FileCard";

// The view primitives moved to FileCard (the leaf module) so the cards and this
// panel don't import each other. Re-exported here because half the chat imports
// them from this path.
export { ArtifactThumb, KindIcon } from "@/components/FileCard";

/** Compact strip of the artifacts ONE turn produced — rendered right after
 * the model reply that created them. */
export function ArtifactsStrip({
  items,
}: {
  items: ArtifactItem[];
}): JSX.Element | null {
  // One card per file, not per write: a turn that writes a document, checks it
  // and fixes it produced ONE document, and that is what belongs under the
  // reply. The intermediate copies stay reachable behind the version chip.
  const groups = groupVersions(items);
  if (groups.length === 0) return null;
  return (
    <div className="space-y-2">
      {groups.map((g, i) => (
        <FileCard
          key={`${g.latest.ts}-${i}-${g.latest.name}`}
          a={g.latest}
          older={g.older}
        />
      ))}
      {groups.length > 1 && (
        <DownloadAllButton items={groups.map((g) => g.latest)} />
      )}
    </div>
  );
}

function SectionHeader({
  label,
  items,
}: {
  label: string;
  items: ArtifactItem[];
}): JSX.Element {
  return (
    <div className="mb-2 flex items-center justify-between gap-2 px-0.5">
      <h4 className="text-sm font-semibold">{label}</h4>
      <DownloadAllButton items={items} compact />
    </div>
  );
}

export function ArtifactsPanel(): JSX.Element {
  const { content, output } = useSessionArtifacts();
  const [showAll, setShowAll] = useState(false);
  // Delivered files are the showcase; a name the model delivered at least once
  // lives there, version chips counting its DELIVERED copies. Every other name
  // — intermediates a script wrote and nobody presented — folds into the
  // collapsed "All files" section. Old chats (every marker was [artifact])
  // land entirely in the showcase, which is faithful to what they were.
  const delivered = output.filter((a) => a.delivered);
  const deliveredGroups = groupVersions(delivered);
  const deliveredNames = new Set(delivered.map((a) => a.name));
  const workingGroups = groupVersions(
    output.filter((a) => !deliveredNames.has(a.name)),
  );
  // Artifacts collapse to one row per file (newest first, earlier copies
  // behind the version chip). Content does not: two attachments with the same
  // name really are two things the user sent.
  const contentNewest = [...content].reverse();

  if (content.length === 0 && output.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
        Files the sandbox produces (Artifacts) and files you attach (Content)
        appear here.
      </div>
    );
  }

  return (
    <div className="space-y-5 p-3">
      {deliveredGroups.length > 0 && (
        <section>
          <SectionHeader
            label="Artifacts"
            items={deliveredGroups.map((g) => g.latest)}
          />
          <div className="space-y-2">
            {deliveredGroups.map((g, i) => (
              <FileCard
                key={`${g.latest.ts}-${i}-${g.latest.name}`}
                a={g.latest}
                older={g.older}
                action="icon"
                surface="panel"
              />
            ))}
          </div>
        </section>
      )}
      {workingGroups.length > 0 && (
        <section>
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="mb-2 flex w-full items-center gap-1 px-0.5 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRight
              className={`size-3.5 transition-transform ${showAll ? "rotate-90" : ""}`}
            />
            All files
            <span className="font-normal">({workingGroups.length})</span>
          </button>
          {showAll && (
            <div className="space-y-2">
              {workingGroups.map((g, i) => (
                <FileCard
                  key={`${g.latest.ts}-${i}-${g.latest.name}`}
                  a={g.latest}
                  older={g.older}
                  action="icon"
                  surface="panel"
                />
              ))}
            </div>
          )}
        </section>
      )}
      {contentNewest.length > 0 && (
        <section>
          <SectionHeader label="Content" items={contentNewest} />
          <div className="grid grid-cols-2 gap-2">
            {contentNewest.map((a, i) => (
              <FileTile key={`${a.source}-${a.ts}-${i}-${a.name}`} a={a} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
