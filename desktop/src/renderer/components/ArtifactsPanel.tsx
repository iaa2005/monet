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
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      {items.map((a, i) => (
        <FileCard key={`${a.ts}-${i}-${a.name}`} a={a} />
      ))}
      {items.length > 1 && <DownloadAllButton items={items} />}
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
  const outputNewest = [...output].reverse();
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
      {outputNewest.length > 0 && (
        <section>
          <SectionHeader label="Artifacts" items={outputNewest} />
          <div className="space-y-2">
            {outputNewest.map((a, i) => (
              <FileCard
                key={`${a.source}-${a.ts}-${i}-${a.name}`}
                a={a}
                action="icon"
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
