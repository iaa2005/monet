/**
 * Connector Store — a modal window with search, install preview, and removal.
 *
 * Community connectors are manifests (data, not code) from
 * github.com/iaa2005/monet-connectors. Installing downloads the manifest +
 * icon into the data dir; the connector then behaves like a builtin one.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Plug,
  Store,
  Search,
  AlertCircle,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/** Inline the service's own SVG. Safe: icons are fetched from the community
 * repo and normalized (namespaced ids) before they land here. */
function ServiceIcon({
  svg,
  className,
}: {
  svg?: string;
  className?: string;
}): JSX.Element {
  if (!svg)
    return <Plug className={cn("shrink-0 text-muted-foreground", className)} />;
  return (
    <span
      role="img"
      aria-hidden="true"
      className={cn("inline-block shrink-0 [&>svg]:size-full", className)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

interface StoreEntry {
  id: string;
  name: string;
  company: string;
  description: string;
  version: string;
  capabilities: string[];
  iconSvg?: string;
}

/** A button that opens the store modal. Shown in the connectors list. */
export function StoreButton({
  onChanged,
}: {
  onChanged: () => void;
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
          <div className="text-sm font-medium">Browse Connector Store</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Community connectors — IMAP, WebDAV, CalDAV, MCP and more
          </div>
        </div>
      </button>
      {open && (
        <StoreModal onClose={() => setOpen(false)} onChanged={onChanged} />
      )}
    </>
  );
}

/** Full-screen store modal with search and install/preview flow. */
function StoreModal({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [entries, setEntries] = useState<StoreEntry[] | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<{
    entry: StoreEntry;
    endpoints: string[];
    authKind: string;
    note?: string;
  } | null>(null);

  const refresh = async (): Promise<void> => {
    setError(null);
    const [cat, inst] = await Promise.all([
      api()?.connectors.storeCatalog(),
      api()?.connectors.storeInstalled(),
    ]);
    setEntries(cat?.entries ?? []);
    if (cat?.error) setError(cat.error);
    setInstalled(new Set(inst ?? []));
  };

  useEffect(() => {
    void refresh();
  }, []);

  const startInstall = async (entry: StoreEntry): Promise<void> => {
    setBusy(entry.id);
    setError(null);
    try {
      const r = await api()?.connectors.storePreview(entry.id);
      if (!r?.ok || !r.preview) throw new Error(r?.error ?? "Preview failed.");
      setConfirm({
        entry,
        endpoints: r.preview.endpoints,
        authKind: r.preview.authKind,
        note: r.preview.note,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doInstall = async (): Promise<void> => {
    if (!confirm) return;
    setBusy(confirm.entry.id);
    try {
      const r = await api()?.connectors.storeInstall(confirm.entry.id);
      if (!r?.ok) throw new Error(r?.error ?? "Install failed.");
      setConfirm(null);
      await refresh();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string): Promise<void> => {
    await api()?.connectors.storeRemove(id);
    await refresh();
    onChanged();
  };

  const filtered = useMemo(() => {
    if (!entries) return null;
    if (!query.trim()) return entries;
    const q = query.toLowerCase();
    return entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.company.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.capabilities.some((c) => c.includes(q)),
    );
  }, [entries, query]);

  return (
    <Modal open onClose={onClose} bare className="h-[85vh] max-w-3xl">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-2">
          <Store className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Connector Store</h2>
          <a
            href="https://github.com/iaa2005/monet-connectors"
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault();
              void api()?.shell.openExternal(
                "https://github.com/iaa2005/monet-connectors",
              );
            }}
            className="ml-2 text-[11px] text-link hover:underline"
          >
            iaa2005/monet-connectors
          </a>
        </div>
      </div>

      {/* Search bar */}
      <div className="shrink-0 border-b border-border px-5 py-2.5">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-black/[0.02] px-3 py-1.5 dark:bg-white/[0.03]">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search connectors…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {error && (
          <p className="mb-3 flex items-start gap-1 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3 shrink-0" />
            <span className="break-words">{error}</span>
          </p>
        )}
        {entries === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading catalog…
          </div>
        ) : filtered === null || filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {query
              ? `No connectors match "${query}".`
              : "The catalog is empty (or unreachable)."}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {filtered.map((s) => {
              const isInstalled = installed.has(s.id);
              return (
                <div
                  key={s.id}
                  className="flex items-start gap-3 rounded-xl border border-border p-3"
                >
                  <ServiceIcon svg={s.iconSvg} className="mt-0.5 size-6" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      {s.name}
                      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                        v{s.version}
                      </span>
                    </div>
                    {s.company && (
                      <div className="text-[11px] text-muted-foreground/70">
                        {s.company}
                      </div>
                    )}
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {s.description}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {s.capabilities.map((c) => (
                        <span
                          key={c}
                          className="rounded bg-black/[0.04] px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground dark:bg-white/[0.06]"
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                  </div>
                  {isInstalled ? (
                    <button
                      type="button"
                      onClick={() => void remove(s.id)}
                      className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-destructive"
                    >
                      Remove
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === s.id}
                      onClick={() => void startInstall(s)}
                      className="shrink-0 rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background disabled:opacity-50"
                    >
                      {busy === s.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        "Install"
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Install confirmation dialog */}
      {confirm && (
        <Modal
          open
          onClose={() => setConfirm(null)}
          title={`Install ${confirm.entry.name}?`}
          className="max-w-lg"
        >
          <div className="space-y-3">
            <p className="text-[13px] text-muted-foreground">
              This connector will talk ONLY to the endpoints below. Your
              credential goes to these servers — check they belong to the
              service you expect.
            </p>
            <ul className="space-y-1 rounded-md border border-border p-2.5 font-mono text-xs">
              {confirm.endpoints.map((e) => (
                <li key={e} className="break-all">
                  {e}
                </li>
              ))}
            </ul>
            {confirm.note && (
              <p className="text-xs text-muted-foreground">{confirm.note}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Auth: {confirm.authKind}. Permissions default to the standard
              matrix (reads allow, writes ask) and are editable after install.
            </p>
            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy === confirm.entry.id}
                onClick={() => void doInstall()}
                className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
              >
                {busy === confirm.entry.id && (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
                Install
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
