/**
 * Connectors — rendered ENTIRELY from the service registry's UI projection.
 *
 * This file names no service. Cards, grouping, icons, the connect form, setup
 * walkthroughs and every message come over IPC from each service's folder
 * (src/main/connectors/services/<id>/). Adding a service there makes it appear
 * here with zero renderer changes; the only branches below are per AUTH KIND
 * (password / token / google-oauth / telegram / unavailable), of which there
 * are exactly five.
 */

import { useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  Loader2,
  Check,
  Trash2,
  Plug,
  AlertCircle,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";
import type { ConnectorAccount } from "../../../main/connectors/types";
import type { UiConnectorService } from "../../../main/connectors/services/types";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

function OpenLink({ url, label }: { url: string; label: string }): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => void api()?.shell.openExternal(url)}
      title={url}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-link transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
    >
      {label}
      <ExternalLink className="size-3.5" />
    </button>
  );
}

/** Inline the service's own SVG. Safe: icons ship inside this app's service
 * folders and are normalized (namespaced ids) before they land there. */
function ServiceIcon({
  svg,
  className,
  dim,
}: {
  svg?: string;
  className?: string;
  dim?: boolean;
}): JSX.Element {
  if (!svg)
    return <Plug className={cn("shrink-0 text-muted-foreground", className)} />;
  return (
    <span
      role="img"
      aria-hidden="true"
      className={cn(
        "inline-block shrink-0 [&>svg]:size-full",
        dim && "opacity-40 grayscale",
        className,
      )}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function ProtocolConnectors(): JSX.Element {
  const [services, setServices] = useState<UiConnectorService[]>([]);
  const [accounts, setAccounts] = useState<ConnectorAccount[]>([]);
  const [entry, setEntry] = useState<UiConnectorService | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});

  const load = (): void => {
    void api()?.connectors.presets().then(setServices).catch(() => {});
    void api()?.connectors.list().then(setAccounts).catch(() => {});
  };
  useEffect(load, []);

  const byId = useMemo(
    () => new Map(services.map((s) => [s.id, s])),
    [services],
  );
  // A company header exists only when it has TWO OR MORE services; companies
  // of one (GitHub, Notion…) share the "Other" bucket. Order follows the
  // registry.
  const groups = useMemo(() => {
    const byCompany = new Map<string, UiConnectorService[]>();
    for (const s of services) {
      const key = s.company || "";
      byCompany.set(key, [...(byCompany.get(key) ?? []), s]);
    }
    const named: { title: string; items: UiConnectorService[] }[] = [];
    const singles: UiConnectorService[] = [];
    for (const [company, items] of byCompany) {
      if (company && items.length >= 2) named.push({ title: company, items });
      else singles.push(...items);
    }
    if (singles.length) named.push({ title: "Other", items: singles });
    return named;
  }, [services]);

  const test = async (id: string): Promise<void> => {
    setTesting(id);
    const r = await api()?.connectors.test(id);
    setResults((p) => ({ ...p, [id]: r?.ok ? "ok" : (r?.error ?? "failed") }));
    setTesting(null);
  };

  const remove = async (id: string): Promise<void> => {
    await api()?.connectors.delete(id);
    load();
  };

  // Off = tools vanish from the model's set and any MCP server shuts down,
  // without throwing the credential away.
  const setEnabled = async (id: string, enabled: boolean): Promise<void> => {
    setAccounts((p) => p.map((a) => (a.id === id ? { ...a, enabled } : a)));
    await api()?.connectors.update(id, { enabled });
    load();
  };

  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-base font-semibold">Connectors</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Your mail, files, calendar, Telegram and dev tools. Each connects with
          a token or app password — no OAuth client to register except where a
          provider demands it — and every secret is encrypted with your OS
          keychain, never written as plain text. For a server that isn&apos;t
          listed here, use MCP Servers.
        </p>
      </section>

      {accounts.length > 0 && (
        <div className="space-y-1.5">
          {accounts.map((a) => {
            const svc = byId.get(a.presetId);
            const res = results[a.id];
            return (
              <div
                key={a.id}
                className="flex items-center gap-3 rounded-xl border border-border p-2.5"
              >
                <ServiceIcon svg={svc?.iconSvg} className="size-5" dim={!a.enabled} />
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      "truncate text-sm font-medium",
                      !a.enabled && "text-muted-foreground",
                    )}
                  >
                    {svc?.displayName ?? a.label}
                    {!a.enabled && " — off"}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {[a.username, svc?.capabilities.join(", ")]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  {res && res !== "ok" && (
                    <div className="mt-1 flex items-start gap-1 text-xs text-destructive">
                      <AlertCircle className="mt-0.5 size-3 shrink-0" />
                      <span className="break-words">{res}</span>
                    </div>
                  )}
                </div>
                {res === "ok" && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Check className="size-3.5" /> works
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void test(a.id)}
                  disabled={testing === a.id || !a.enabled}
                  className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  {testing === a.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    "Test"
                  )}
                </button>
                <Switch
                  checked={a.enabled}
                  onChange={(v) => void setEnabled(a.id, v)}
                />
                <button
                  type="button"
                  onClick={() => void remove(a.id)}
                  aria-label={`Remove ${a.label}`}
                  className="rounded-md p-1 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {groups.map((g) => (
        <div key={g.title}>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            {g.title}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {g.items.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setEntry(s)}
                  className="flex items-start gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                >
                  <ServiceIcon
                    svg={s.iconSvg}
                    className="mt-0.5 size-6"
                    dim={s.auth.kind === "unavailable"}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{s.displayName}</div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {s.auth.kind === "unavailable"
                        ? "Not connectable yet — read why"
                        : s.description}
                    </div>
                  </div>
                </button>
              ))}
          </div>
        </div>
      ))}

      {entry && (
        <ConnectForm
          service={entry}
          onClose={() => setEntry(null)}
          onDone={() => {
            setEntry(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function ConnectForm({
  service,
  onClose,
  onDone,
}: {
  service: UiConnectorService;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  // Generic field values, keyed by AuthField.key ("username" + secret keys).
  const [values, setValues] = useState<Record<string, string>>({});
  // Telegram's two-step state.
  const [stage, setStage] = useState<"form" | "code">("form");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [twoFa, setTwoFa] = useState("");
  const [needs2fa, setNeeds2fa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: string, v: string): void =>
    setValues((p) => ({ ...p, [k]: v }));

  const field =
    "mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/30";

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      switch (service.auth.kind) {
        case "password": {
          const secret: Record<string, string> = {};
          for (const f of service.auth.fields)
            if (f.key !== "username") secret[f.key] = values[f.key] ?? "";
          await api()?.connectors.add({
            presetId: service.id,
            username: values.username ?? "",
            secret,
          });
          onDone();
          return;
        }
        case "token": {
          await api()?.connectors.add({
            presetId: service.id,
            username: "",
            secret: { [service.auth.field.key]: values[service.auth.field.key] ?? "" },
          });
          onDone();
          return;
        }
        case "google-oauth": {
          const r = await api()?.connectors.googleSignIn({
            presetId: service.id,
            clientId: values.clientId ?? "",
            clientSecret: values.clientSecret ?? "",
          });
          if (!r?.ok) throw new Error(r?.error ?? "Sign-in failed.");
          onDone();
          return;
        }
        case "telegram": {
          // Create the account first: its id keys both the pending login and
          // the session written back after the code is confirmed.
          const acct = await api()?.connectors.add({
            presetId: service.id,
            username: values.phone ?? "",
            secret: { apiId: values.apiId ?? "", apiHash: values.apiHash ?? "" },
          });
          if (!acct) throw new Error("Could not create the account.");
          setAccountId(acct.id);
          const r = await api()?.connectors.telegramSendCode({
            accountId: acct.id,
            apiId: values.apiId ?? "",
            apiHash: values.apiHash ?? "",
            phone: values.phone ?? "",
          });
          if (!r?.ok)
            throw new Error(r?.error ?? "Telegram refused the request.");
          setStage("code");
          return;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect.");
    } finally {
      setBusy(false);
    }
  };

  const signIn = async (): Promise<void> => {
    if (!accountId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api()?.connectors.telegramSignIn({
        accountId,
        code,
        password: twoFa || undefined,
      });
      if (r?.needsPassword) {
        setNeeds2fa(true);
        setError("This account has 2FA — enter your Telegram password too.");
        return;
      }
      if (!r?.ok) throw new Error(r?.error ?? "Sign-in failed.");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  const kind = service.auth.kind;

  return (
    <Modal open onClose={onClose} title={`Connect ${service.displayName}`}>
      <div className="space-y-3">
        <ServiceIcon svg={service.iconSvg} className="size-9" />

        {kind === "unavailable" ? (
          <>
            <p className="text-[13px] text-muted-foreground">
              {service.auth.kind === "unavailable" ? service.auth.reason : ""}
            </p>
            <div className="flex justify-end gap-2 border-t border-border pt-3">
              {service.credUrl && (
                <OpenLink
                  url={service.credUrl}
                  label={service.credLabel ?? "Learn more"}
                />
              )}
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            {service.note && (
              <p className="rounded-md border border-border bg-black/[0.02] p-2 text-[13px] text-muted-foreground dark:bg-white/[0.03]">
                {service.note}
              </p>
            )}

            {stage === "form" && service.setupSteps && service.setupSteps.length > 0 && (
              <ol className="space-y-2 rounded-md border border-border p-3">
                {service.setupSteps.map((s, i) => (
                  <li key={i} className="flex gap-2.5 text-[13px]">
                    <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full bg-black/[0.06] text-[10px] font-medium text-muted-foreground dark:bg-white/[0.1]">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 text-muted-foreground">
                      {s.text}
                      {s.url && (
                        <span className="ml-1 inline-block align-text-bottom">
                          <OpenLink url={s.url} label={s.urlLabel ?? "Open"} />
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            )}

            {stage === "form" ? (
              <>
                {kind === "password" &&
                  service.auth.kind === "password" &&
                  service.auth.fields.map((f) => (
                    <div key={f.key}>
                      <div className="flex items-center justify-between gap-2">
                        <label className="text-xs text-muted-foreground">
                          {f.label}
                        </label>
                        {f.secret && service.credUrl && (
                          <OpenLink
                            url={service.credUrl}
                            label={service.credLabel ?? "Get credential"}
                          />
                        )}
                      </div>
                      <input
                        type={f.secret ? "password" : "text"}
                        value={values[f.key] ?? ""}
                        onChange={(e) => set(f.key, e.target.value)}
                        placeholder={
                          f.placeholder ??
                          (f.secret
                            ? "Encrypted with your OS keychain"
                            : undefined)
                        }
                        className={cn(field, f.mono && "font-mono text-xs")}
                      />
                    </div>
                  ))}

                {kind === "token" && service.auth.kind === "token" && (
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-xs text-muted-foreground">
                        {service.auth.field.label}
                      </label>
                      {service.credUrl && (
                        <OpenLink
                          url={service.credUrl}
                          label={service.credLabel ?? "Get token"}
                        />
                      )}
                    </div>
                    <input
                      type="password"
                      value={values[service.auth.field.key] ?? ""}
                      onChange={(e) =>
                        service.auth.kind === "token" &&
                        set(service.auth.field.key, e.target.value)
                      }
                      placeholder="Paste your token — stored encrypted, sent only to the server"
                      className={cn(field, "font-mono text-xs")}
                    />
                  </div>
                )}

                {kind === "google-oauth" && (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        {service.credLabel ?? "OAuth client (Desktop app)"}
                      </span>
                      {service.credUrl && (
                        <OpenLink url={service.credUrl} label="Google Cloud" />
                      )}
                    </div>
                    <input
                      value={values.clientId ?? ""}
                      onChange={(e) => set("clientId", e.target.value)}
                      placeholder="Client ID (…apps.googleusercontent.com)"
                      className={cn(field, "font-mono text-xs")}
                    />
                    <input
                      type="password"
                      value={values.clientSecret ?? ""}
                      onChange={(e) => set("clientSecret", e.target.value)}
                      placeholder="Client secret"
                      className={cn(field, "font-mono text-xs")}
                    />
                  </>
                )}

                {kind === "telegram" && (
                  <>
                    <div>
                      <label className="text-xs text-muted-foreground">
                        Phone number
                      </label>
                      <input
                        value={values.phone ?? ""}
                        onChange={(e) => set("phone", e.target.value)}
                        placeholder="+79991234567"
                        className={field}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        {service.credLabel ?? "api_id + api_hash"}
                      </span>
                      {service.credUrl && (
                        <OpenLink url={service.credUrl} label="Get api_id" />
                      )}
                    </div>
                    <div className="flex gap-2">
                      <input
                        value={values.apiId ?? ""}
                        onChange={(e) => set("apiId", e.target.value)}
                        placeholder="api_id"
                        className={cn(field, "w-32 font-mono text-xs")}
                      />
                      <input
                        value={values.apiHash ?? ""}
                        onChange={(e) => set("apiHash", e.target.value)}
                        placeholder="api_hash"
                        className={cn(field, "flex-1 font-mono text-xs")}
                      />
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <p className="text-[13px] text-muted-foreground">
                  Telegram sent a code to {values.phone}. Enter it to finish
                  signing in.
                </p>
                <div>
                  <label className="text-xs text-muted-foreground">Code</label>
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="12345"
                    className={cn(field, "font-mono")}
                  />
                </div>
                {needs2fa && (
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Telegram 2FA password
                    </label>
                    <input
                      type="password"
                      value={twoFa}
                      onChange={(e) => setTwoFa(e.target.value)}
                      className={field}
                    />
                  </div>
                )}
              </>
            )}

            {error && <p className="text-[13px] text-destructive">{error}</p>}

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void (stage === "form" ? submit() : signIn())}
                className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
              >
                {busy && <Loader2 className="size-3.5 animate-spin" />}
                {stage === "form"
                  ? kind === "google-oauth"
                    ? busy
                      ? "Waiting for the browser…"
                      : "Sign in with Google"
                    : kind === "telegram"
                      ? "Send code"
                      : "Connect"
                  : "Sign in"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
