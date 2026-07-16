/**
 * Built-in connectors — accounts that speak a standard protocol (IMAP/SMTP,
 * WebDAV, CalDAV/CardDAV, MTProto) with an app password.
 *
 * These deliberately avoid OAuth: the services here either don't ship a usable
 * MCP server, or hide it behind an OAuth client you'd have to register in a
 * cloud console. An app password is two clicks on a page we link to.
 */

import { useEffect, useState } from "react";
import {
  ExternalLink,
  Loader2,
  Check,
  Trash2,
  Plug,
  AlertCircle,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import { ConnectorIcon, hasConnectorIcon } from "./connector-icons";
import type { ElectronAPI } from "@/types/electron";
import type {
  ConnectorAccount,
  ConnectorPreset,
} from "../../../main/connectors/types";

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

export function ProtocolConnectors(): JSX.Element {
  const [presets, setPresets] = useState<ConnectorPreset[]>([]);
  const [accounts, setAccounts] = useState<ConnectorAccount[]>([]);
  const [entry, setEntry] = useState<ConnectorPreset | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});

  const load = (): void => {
    void api()?.connectors.presets().then(setPresets).catch(() => {});
    void api()?.connectors.list().then(setAccounts).catch(() => {});
  };
  useEffect(load, []);

  const test = async (id: string): Promise<void> => {
    setTesting(id);
    const r = await api()?.connectors.test(id);
    setResults((p) => ({
      ...p,
      [id]: r?.ok ? "ok" : (r?.error ?? "failed"),
    }));
    setTesting(null);
  };

  const remove = async (id: string): Promise<void> => {
    await api()?.connectors.delete(id);
    load();
  };

  const groups = Array.from(new Set(presets.map((p) => p.group)));

  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-base font-semibold">Built-in connectors</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Your mail, files, calendar and Telegram — over their standard
          protocols, with an app password instead of an OAuth client. Passwords
          are encrypted with your OS keychain, never stored as plain text.
        </p>
      </section>

      {accounts.length > 0 && (
        <div className="space-y-1.5">
          {accounts.map((a) => {
            const preset = presets.find((p) => p.id === a.presetId);
            const res = results[a.id];
            return (
              <div
                key={a.id}
                className="flex items-center gap-3 rounded-xl border border-border p-2.5"
              >
                {hasConnectorIcon(a.presetId) ? (
                  <ConnectorIcon presetId={a.presetId} className="size-5" />
                ) : (
                  <Plug className="size-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{a.label}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {a.username}
                    {preset ? ` · ${preset.protocols.join(", ")}` : ""}
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
                  disabled={testing === a.id}
                  className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  {testing === a.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    "Test"
                  )}
                </button>
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
        <div key={g}>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">{g}</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {presets
              .filter((p) => p.group === g)
              .map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setEntry(p)}
                  className="flex items-start gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                >
                  {hasConnectorIcon(p.id) ? (
                    <ConnectorIcon
                      presetId={p.id}
                      className={cn("mt-0.5 size-6", p.unavailable && "opacity-40")}
                    />
                  ) : (
                    <Plug className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{p.name}</div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {p.unavailable
                        ? (p.unavailableLabel ?? "Read how to connect this")
                        : p.protocols.join(", ")}
                    </div>
                  </div>
                </button>
              ))}
          </div>
        </div>
      ))}

      {entry && (
        <ConnectForm
          preset={entry}
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
  preset,
  onClose,
  onDone,
}: {
  preset: ConnectorPreset;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [code, setCode] = useState("");
  const [twoFa, setTwoFa] = useState("");
  const [needs2fa, setNeeds2fa] = useState(false);
  const [stage, setStage] = useState<"form" | "code">("form");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isTelegram = !!preset.telegram;

  // No app-password path (Google Drive): say why, and point at the way in.
  if (preset.unavailable) {
    return (
      <Modal open onClose={onClose} title={preset.name}>
        <div className="space-y-3">
          {hasConnectorIcon(preset.id) && (
            <ConnectorIcon presetId={preset.id} className="size-9" />
          )}
          <p className="text-[13px] text-muted-foreground">{preset.unavailable}</p>
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            {preset.credUrl && (
              <OpenLink url={preset.credUrl} label={preset.credLabel ?? "Learn more"} />
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (isTelegram) {
        // Create the account first: its id keys both the pending login and the
        // session we write back after the code is confirmed.
        const acct = await api()?.connectors.add({
          presetId: preset.id,
          username,
          secret: { apiId, apiHash },
        });
        if (!acct) throw new Error("Could not create the account.");
        setAccountId(acct.id);
        const r = await api()?.connectors.telegramSendCode({
          accountId: acct.id,
          apiId,
          apiHash,
          phone: username,
        });
        if (!r?.ok) throw new Error(r?.error ?? "Telegram refused the request.");
        setStage("code");
      } else {
        await api()?.connectors.add({
          presetId: preset.id,
          username,
          secret: { password },
        });
        onDone();
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

  const field =
    "mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/30";

  return (
    <Modal open onClose={onClose} title={`Connect ${preset.name}`}>
      <div className="space-y-3">
        {hasConnectorIcon(preset.id) && (
          <ConnectorIcon presetId={preset.id} className="size-9" />
        )}
        {preset.note && (
          <p className="rounded-md border border-border bg-black/[0.02] p-2 text-[13px] text-muted-foreground dark:bg-white/[0.03]">
            {preset.note}
          </p>
        )}

        {stage === "form" ? (
          <>
            <div>
              <label className="text-xs text-muted-foreground">
                {isTelegram ? "Phone number" : "Login"}
              </label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={preset.usernameLabel}
                className={field}
              />
            </div>

            {isTelegram ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {preset.credLabel}
                  </span>
                  {preset.credUrl && (
                    <OpenLink url={preset.credUrl} label="Get api_id" />
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    value={apiId}
                    onChange={(e) => setApiId(e.target.value)}
                    placeholder="api_id"
                    className={cn(field, "w-32 font-mono text-xs")}
                  />
                  <input
                    value={apiHash}
                    onChange={(e) => setApiHash(e.target.value)}
                    placeholder="api_hash"
                    className={cn(field, "flex-1 font-mono text-xs")}
                  />
                </div>
              </>
            ) : (
              <div>
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs text-muted-foreground">
                    {preset.credLabel ?? "App password"}
                  </label>
                  {preset.credUrl && (
                    <OpenLink url={preset.credUrl} label="Create app password" />
                  )}
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Encrypted with your OS keychain"
                  className={field}
                />
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-[13px] text-muted-foreground">
              Telegram sent a code to {username}. Enter it to finish signing in.
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
            {stage === "form" ? (isTelegram ? "Send code" : "Connect") : "Sign in"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
