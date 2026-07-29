/**
 * Directory → Connectors. Built-in services (compiled into the app) and
 * community manifests from github.com/iaa2005/monet-directory, in one grid.
 *
 * Installing a community connector still goes through the endpoint
 * confirmation dialog: a manifest decides where your credential is sent, so
 * the hosts it will talk to are shown before anything is written to disk.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, Plus, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { ConnectForm } from "@/components/settings/ProtocolConnectors";
import type { UiConnectorService } from "../../../main/connectors/services/types";
import {
  api,
  CardAction,
  Chip,
  DirCard,
  Empty,
  matches,
  Picker,
  ServiceIcon,
} from "./shared";
import { Toolbar } from "./SkillsSection";

const STORE_REPO = "iaa2005/monet-directory";

interface StoreEntry {
  id: string;
  name: string;
  displayName?: string;
  company: string;
  description: string;
  version: string;
  capabilities: string[];
  iconSvg?: string;
}

const FILTERS = [
  { label: "All", value: "all" },
  { label: "Ready to connect", value: "ready" },
  { label: "Needs installing", value: "available" },
];
const SORTS = [
  { label: "Name", value: "name" },
  { label: "Company", value: "company" },
];

type Origin = "builtin" | "store";

/** One row in the merged grid: a built-in service, an installed community
 * connector (both are `UiConnectorService`), or one still to download. */
interface Row {
  key: string;
  origin: Origin;
  installed: boolean;
  name: string;
  company: string;
  description: string;
  capabilities: string[];
  iconSvg?: string;
  version?: string;
  service?: UiConnectorService;
  entry?: StoreEntry;
}

export function ConnectorsSection({ query }: { query: string }): JSX.Element {
  const [services, setServices] = useState<UiConnectorService[] | null>(null);
  const [entries, setEntries] = useState<StoreEntry[] | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [origin, setOrigin] = useState<"all" | Origin>("all");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("name");
  const [connect, setConnect] = useState<UiConnectorService | null>(null);
  const [confirm, setConfirm] = useState<{
    entry: StoreEntry;
    endpoints: string[];
    authKind: string;
    note?: string;
  } | null>(null);

  const load = async (): Promise<void> => {
    const [svcs, cat, inst] = await Promise.all([
      api()?.connectors.presets(),
      api()?.connectors.storeCatalog(),
      api()?.connectors.storeInstalled(),
    ]);
    setServices(svcs ?? []);
    setEntries(cat?.entries ?? []);
    if (cat?.error) setError(cat.error);
    setInstalled(new Set(inst ?? []));
  };

  useEffect(() => {
    void load();
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
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string): Promise<void> => {
    setBusy(id);
    try {
      const r = await api()?.connectors.storeRemove(id);
      if (r && !r.ok) setError(r.error ?? "Failed to remove.");
      await load();
    } finally {
      setBusy(null);
    }
  };

  // presets() returns built-ins AND installed community connectors together;
  // `installed` (ids from the store) is what tells them apart.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const s of services ?? []) {
      const fromStore = installed.has(s.id);
      out.push({
        key: s.id,
        origin: fromStore ? "store" : "builtin",
        installed: true,
        name: s.displayName ?? s.name,
        company: s.company,
        description:
          s.auth.kind === "unavailable"
            ? "Not connectable yet — open it to read why."
            : s.description,
        capabilities: s.capabilities,
        iconSvg: s.iconSvg,
        service: s,
      });
    }
    for (const e of entries ?? []) {
      if (installed.has(e.id)) continue;
      out.push({
        key: e.id,
        origin: "store",
        installed: false,
        name: e.displayName ?? e.name,
        company: e.company,
        description: e.description,
        capabilities: e.capabilities,
        iconSvg: e.iconSvg,
        version: e.version,
        entry: e,
      });
    }
    return out;
  }, [services, entries, installed]);

  const shown = useMemo(() => {
    let list = rows.filter(
      (r) =>
        (origin === "all" || r.origin === origin) &&
        (filter === "all" || (filter === "ready" ? r.installed : !r.installed)) &&
        matches(query, r.name, r.company, r.description, r.capabilities.join(" ")),
    );
    list = [...list];
    if (sort === "company")
      list.sort(
        (a, b) => a.company.localeCompare(b.company) || a.name.localeCompare(b.name),
      );
    else list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [rows, origin, filter, sort, query]);

  return (
    <>
      <Toolbar
        chips={
          <>
            <Chip
              label="All"
              active={origin === "all"}
              onClick={() => setOrigin("all")}
            />
            <Chip
              label="Built-in"
              active={origin === "builtin"}
              onClick={() => setOrigin(origin === "builtin" ? "all" : "builtin")}
            />
            <Chip
              label={STORE_REPO.split("/")[1]}
              title={STORE_REPO}
              active={origin === "store"}
              onClick={() => setOrigin(origin === "store" ? "all" : "store")}
            />
            <button
              type="button"
              onClick={() =>
                void api()?.shell.openExternal(`https://github.com/${STORE_REPO}`)
              }
              className="shrink-0 text-[11px] text-link hover:underline"
            >
              {STORE_REPO}
            </button>
          </>
        }
        right={
          <>
            <Picker
              label="Filter by"
              value={filter}
              options={FILTERS}
              onChange={setFilter}
            />
            <Picker
              label="Sort by"
              value={sort}
              options={SORTS}
              onChange={setSort}
            />
          </>
        }
      />

      {error && (
        <p className="mb-3 flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3 shrink-0" />
          <span className="break-words">{error}</span>
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {services === null ? (
          <Empty>
            <Loader2 className="mx-auto size-5 animate-spin" />
          </Empty>
        ) : shown.length === 0 ? (
          <Empty>
            {query ? `Nothing matches “${query}”.` : "Nothing here."}
          </Empty>
        ) : (
          shown.map((r) => (
            <DirCard
              key={r.key}
              icon={
                <ServiceIcon
                  svg={r.iconSvg}
                  className="mt-0.5 size-6"
                  dim={r.service?.auth.kind === "unavailable"}
                />
              }
              title={r.name}
              meta={
                <>
                  <span className="truncate">
                    {r.company || (r.origin === "builtin" ? "Built-in" : STORE_REPO)}
                  </span>
                  {r.version && <span>· v{r.version}</span>}
                  {r.capabilities.length > 0 && (
                    <span className="truncate font-mono">
                      · {r.capabilities.join(" ")}
                    </span>
                  )}
                </>
              }
              description={r.description}
              onClick={r.service ? () => setConnect(r.service!) : undefined}
              action={
                r.installed ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (r.service) setConnect(r.service);
                      }}
                      className="rounded-lg bg-foreground px-2.5 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90"
                    >
                      Connect
                    </button>
                    {r.origin === "store" && (
                      <CardAction
                        icon={Trash2}
                        title="Remove this connector"
                        variant="danger"
                        busy={busy === r.key}
                        onClick={() => void remove(r.key)}
                      />
                    )}
                  </div>
                ) : (
                  <CardAction
                    icon={Plus}
                    title="Install this connector"
                    busy={busy === r.key}
                    onClick={() => r.entry && void startInstall(r.entry)}
                  />
                )
              }
            />
          ))
        )}
      </div>

      {confirm && (
        <Modal
          open
          onClose={() => setConfirm(null)}
          title={`Install ${confirm.entry.displayName ?? confirm.entry.name}?`}
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

      {connect && (
        <ConnectForm
          service={connect}
          onClose={() => setConnect(null)}
          onDone={() => {
            setConnect(null);
            void load();
          }}
        />
      )}
    </>
  );
}
