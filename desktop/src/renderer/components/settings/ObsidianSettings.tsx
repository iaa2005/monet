/**
 * Settings → Obsidian — the vault registry.
 *
 * A vault is a pointer to a folder the user owns, anywhere on disk (cloud
 * sync folders included). Nothing is copied and nothing is ever deleted from
 * here: "Remove" forgets the pointer, the notes stay where they are.
 *
 * The two switches map 1:1 onto what the agent may do: Enabled gates the
 * Vault tools' existence, Read-only keeps VaultWrite out of this vault.
 */

import { useEffect, useState } from "react";
import {
  BookOpen,
  FolderOpen,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Waypoints,
} from "lucide-react";
import { ObsidianIcon } from "@/components/ObsidianIcon";
import { useDockStore } from "@/dock/dock-store";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { ElectronAPI, UiVault } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

export function ObsidianSettings(): JSX.Element {
  const [vaults, setVaults] = useState<UiVault[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    const list = await api()?.obsidian.list();
    if (list) setVaults(list);
  };
  useEffect(() => {
    void load();
  }, []);

  const addVault = async (): Promise<void> => {
    setError(null);
    const path = await api()?.files.pickDirectory();
    if (!path) return;
    setBusy(true);
    try {
      const r = await api()?.obsidian.add(path);
      if (r && !r.ok) setError(r.error ?? "Couldn't add that folder.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const patch = async (
    id: string,
    p: { enabled?: boolean; readOnly?: boolean },
  ): Promise<void> => {
    await api()?.obsidian.update(id, p);
    await load();
  };

  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-base font-semibold">Obsidian</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Connect your Obsidian vaults — folders of linked Markdown notes,
          wherever they live (a cloud-synced folder works). The agent gets
          three tools: search the vault, read a note with its links and
          backlinks, and — only when you ask it to save something — write.
          Nothing is uploaded anywhere; notes are read from disk on demand and
          never fed to the model wholesale.
        </p>
      </section>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void addVault()}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Plus className="size-4" />
          Add vault…
        </button>
        <button
          type="button"
          title="Re-scan all vaults"
          onClick={() => void load()}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
        >
          <RefreshCw className="size-4" />
        </button>
        {vaults.some((v) => v.enabled) && (
          <button
            type="button"
            onClick={() => {
              useDockStore.getState().openPanel("vault");
              // The panel opens BEHIND the settings dialog — close it, or
              // the click appears to do nothing.
              window.dispatchEvent(new Event("monet-close-settings"));
            }}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
          >
            <Waypoints className="size-4" />
            Open graph
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-amber-500/10 px-3 py-2 text-[13px] text-amber-600 dark:text-amber-400">
          {error}
        </div>
      )}

      {vaults.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No vaults yet. Point the app at an Obsidian vault folder — or any
          folder of Markdown notes — and the agent will be able to search it,
          follow its [[wikilinks]] and cite your notes.
        </div>
      ) : (
        <div className="space-y-2">
          {vaults.map((v) => (
            <div
              key={v.id}
              className={cn(
                "rounded-lg border border-border bg-card p-3",
                !v.enabled && "opacity-60",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2.5">
                  <ObsidianIcon className="mt-0.5 size-4 shrink-0 text-brand" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {v.name}
                      {!v.present && (
                        <span className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-normal text-amber-600 dark:text-amber-400">
                          <TriangleAlert className="size-3" />
                          folder not found
                        </span>
                      )}
                      {v.present && !v.isObsidian && (
                        <span
                          title="No .obsidian folder — plain Markdown works fine, this is only a hint"
                          className="rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] font-normal text-muted-foreground dark:bg-white/[0.07]"
                        >
                          plain folder
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {v.path}
                    </div>
                    {v.stats && (
                      <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                        <BookOpen className="size-3" />
                        {v.stats.notes} notes · {v.stats.links} links ·{" "}
                        {v.stats.tags} tags
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    title="Open folder"
                    onClick={() => void api()?.obsidian.openFolder(v.id)}
                    className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
                  >
                    <FolderOpen className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Remove from the app (the folder and notes stay on disk)"
                    onClick={() =>
                      void api()
                        ?.obsidian.remove(v.id)
                        .then(() => load())
                    }
                    className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-5 border-t border-border pt-2">
                <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                  <Switch
                    checked={v.enabled}
                    onChange={(on) => void patch(v.id, { enabled: on })}
                  />
                  Enabled
                </label>
                <label
                  className="flex cursor-pointer items-center gap-2 text-[13px]"
                  title="The agent may search and read, but never write here"
                >
                  <Switch
                    checked={v.readOnly}
                    onChange={(on) => void patch(v.id, { readOnly: on })}
                  />
                  Read-only
                </label>
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="rounded-lg bg-black/[0.03] p-3 text-[12px] leading-relaxed text-muted-foreground dark:bg-white/[0.04]">
        <p>
          <span className="font-medium text-foreground">How the agent uses a vault:</span>{" "}
          it searches first, reads the two-three most relevant notes and follows
          their [[wikilinks]] — the vault is never loaded into the model
          wholesale. Writing happens only when you explicitly ask to save
          something, always lands as linked Markdown, and every write asks for
          permission like any file change outside your workspace. This is
          separate from Memory: Memory is what the agent learns about you by
          itself; the vault is the knowledge base you author.
        </p>
      </section>
    </div>
  );
}
