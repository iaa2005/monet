/**
 * "These connectors need you again" — once, at launch.
 *
 * A remote MCP grant expires while the app is closed, and the failure used to
 * be invisible until a chat asked for a tool and got nothing. Worse, the old
 * behaviour was the opposite extreme: the app dragged the user into the
 * browser unasked, several tabs at a time. This is the middle: the app says
 * what is stale, shows which connectors, and each one signs in on a click —
 * with the browser opening only when a person asks for it.
 *
 * Shown once per launch and dismissible. It appears only when something is
 * actually wrong: the check is a real connection attempt, not "is a token on
 * disk", so a working connector is never mentioned.
 */

import { useEffect, useState } from "react";
import { KeyRound, Loader2, X } from "@/components/icons/hg";
import { cn } from "@/lib/utils";
import type { ElectronAPI, McpAuthNeed } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/** Wait for the first connect pass rather than racing it: asking during
 * startup would report "expired" for a server that simply had not answered
 * yet, which is a lie that costs the user a browser round trip. */
const CHECK_DELAY_MS = 4_000;

interface Preset {
  id: string;
  displayName: string;
  iconSvg?: string;
}

export function ConnectorAuthToast(): JSX.Element | null {
  const [needs, setNeeds] = useState<McpAuthNeed[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    const id = window.setTimeout(() => {
      void api()
        ?.connectors.authNeeds()
        .then((list) => {
          if (alive) setNeeds(list ?? []);
        })
        .catch(() => {
          /* nothing to say if the check itself cannot run */
        });
      void api()
        ?.connectors.presets()
        .then((p) => {
          if (alive) setPresets((p ?? []) as Preset[]);
        })
        .catch(() => {});
    }, CHECK_DELAY_MS);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, []);

  if (dismissed || needs.length === 0) return null;

  const iconOf = (presetId: string): string | undefined =>
    presets.find((p) => p.id === presetId)?.iconSvg;

  const signIn = async (need: McpAuthNeed): Promise<void> => {
    setBusy(need.accountId);
    setFailed((f) => {
      const n = { ...f };
      delete n[need.accountId];
      return n;
    });
    const r = await api()?.connectors.mcpOAuthSignIn({ presetId: need.presetId });
    setBusy(null);
    if (r?.ok) setNeeds((list) => list.filter((n) => n.accountId !== need.accountId));
    else
      setFailed((f) => ({
        ...f,
        [need.accountId]: r?.error ?? "Sign-in did not complete.",
      }));
  };

  return (
    <div className="pointer-events-auto fixed bottom-4 right-4 z-50 w-[330px] rounded-xl border border-border bg-card p-3 shadow-xl">
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">
            {needs.length === 1
              ? "A connector needs you to sign in again"
              : `${needs.length} connectors need you to sign in again`}
          </div>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            Their access expired while the app was closed. Nothing opens until
            you ask.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="mt-2 space-y-1">
        {needs.map((n) => {
          const svg = iconOf(n.presetId);
          return (
            <div key={n.accountId}>
              <div className="flex items-center gap-2 rounded-lg px-1 py-1">
                {svg ? (
                  <span
                    className="size-4 shrink-0 [&>svg]:size-4"
                    dangerouslySetInnerHTML={{ __html: svg }}
                  />
                ) : (
                  <span className="size-4 shrink-0 rounded bg-muted" />
                )}
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {n.label}
                </span>
                <button
                  type="button"
                  disabled={busy === n.accountId}
                  onClick={() => void signIn(n)}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 rounded-md bg-foreground px-2 py-1 text-[11px] font-medium text-background transition-opacity hover:opacity-90",
                    busy === n.accountId && "opacity-60",
                  )}
                >
                  {busy === n.accountId && (
                    <Loader2 className="size-3 animate-spin" />
                  )}
                  {busy === n.accountId ? "In the browser…" : "Sign in"}
                </button>
              </div>
              {failed[n.accountId] && (
                <p className="px-1 pb-1 text-[11px] text-destructive">
                  {failed[n.accountId]}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
