/**
 * Artifacts panel — the current chat's files, in two groups:
 *   Artifacts — output the sandbox produced (charts, docs, data).
 *   Content   — input the user attached to their messages.
 *
 * Files live on disk (<dataDir>/artifacts/<sessionId>/…); image previews are
 * re-read lazily from the artifact path, so they survive chat switches and
 * restarts. Clicking an item opens it with the OS default app.
 */

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
export {
  ArtifactThumb,
  KindIcon,
  openArtifact,
  viewArtifact,
} from "@/components/FileCard";

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
  // Artifacts collapse to one row per file (newest first, earlier copies
  // behind the version chip). Content does not: two attachments with the same
  // name really are two things the user sent.
  const outputGroups = groupVersions(output);
  const outputLatest = outputGroups.map((g) => g.latest);
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
      {outputGroups.length > 0 && (
        <section>
          <SectionHeader label="Artifacts" items={outputLatest} />
          <div className="space-y-2">
            {outputGroups.map((g, i) => (
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
