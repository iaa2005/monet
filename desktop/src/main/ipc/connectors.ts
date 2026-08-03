/**
 * Connectors IPC — the registry's UI projection, account CRUD, per-service
 * tests, and the two special sign-in flows (Google OAuth, Telegram phone).
 *
 * Secrets travel renderer→main only (to be encrypted and stored); nothing here
 * ever sends one back out. The renderer receives UiConnectorService objects and
 * renders the whole connect form from them — this file names no service.
 */

import { ipcMain } from "electron";
import {
  addAccount,
  deleteAccount,
  getService,
  listAccounts,
  resolveAccount,
  SERVICES,
  setAccountPermission,
  updateAccount,
} from "../connectors/index.js";
import { toUiService } from "../connectors/services/types.js";
import type { UiConnectorService } from "../connectors/services/types.js";
import { allServices } from "../connectors/services/registry.js";
import {
  fetchCatalog,
  installStoreConnector,
  installedStoreIds,
  previewStoreConnector,
  refreshInstalledServices,
  removeStoreConnector,
  type CatalogEntry,
  type ManifestPreview,
} from "../connectors/store-catalog.js";
import { resetVendorTools } from "../agent/vendor-tools.js";
import { ensureConnected, loadConfig } from "../mcp/manager.js";
import type { ConnectorAccount, ConnectorSecret } from "../connectors/types.js";

export function registerConnectorsIPC(): void {
  // Join store-installed manifests into the registry before anything asks.
  refreshInstalledServices();

  ipcMain.handle(
    "connectors:presets",
    (): UiConnectorService[] => allServices().map(toUiService),
  );
  ipcMain.handle("connectors:list", (): ConnectorAccount[] => listAccounts());

  /**
   * Everything a routine can be scoped to, in one list: connector accounts plus
   * any hand-written MCP server. The id is what a routine stores — a service id
   * for a connector, the server name for a raw MCP server.
   */
  ipcMain.handle(
    "connectors:options",
    (): { id: string; label: string; kind: "connector" | "mcp" }[] => {
      const out: { id: string; label: string; kind: "connector" | "mcp" }[] = [];
      const seen = new Set<string>();
      for (const a of listAccounts()) {
        if (!a.enabled || seen.has(a.presetId)) continue;
        seen.add(a.presetId);
        out.push({
          id: a.presetId,
          label: getService(a.presetId)?.name ?? a.label,
          kind: "connector",
        });
      }
      for (const name of Object.keys(loadConfig().mcpServers)) {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ id: name, label: name, kind: "mcp" });
      }
      return out;
    },
  );

  ipcMain.handle(
    "connectors:add",
    (
      _e,
      input: {
        presetId: string;
        label?: string;
        username: string;
        secret: ConnectorSecret;
      },
    ): ConnectorAccount => {
      const service = getService(input.presetId);
      if (!service) throw new Error(`Unknown connector: ${input.presetId}`);
      const account = addAccount(input, {
        // One server, one token: a second MCP account would silently shadow the
        // first, so reconnecting replaces instead.
        singleton: !!service.capabilities.mcp,
        defaultLabel: service.name,
      });
      resetVendorTools(); // tool advertisement depends on which accounts exist
      // MCP-backed service: bring its server up now, so the token is proven (or
      // the error surfaced) while the user is still looking at the form.
      if (service.capabilities.mcp) void ensureConnected().catch(() => {});
      return account;
    },
  );

  ipcMain.handle(
    "connectors:update",
    (
      _e,
      id: string,
      patch: Partial<Pick<ConnectorAccount, "label" | "username" | "enabled">>,
    ) => {
      const row = updateAccount(id, patch);
      resetVendorTools();
      // Enabling/disabling an MCP connector adds or drops its server.
      void ensureConnected().catch(() => {});
      return row;
    },
  );

  // Per-action permission override (null clears back to the default). Pure
  // store write — the engine reads the account row on every call.
  ipcMain.handle(
    "connectors:setPermission",
    (
      _e,
      accountId: string,
      actionId: string,
      level: "allow" | "ask" | "deny" | null,
    ): ConnectorAccount | null => setAccountPermission(accountId, actionId, level),
  );

  ipcMain.handle("connectors:delete", (_e, id: string): { ok: boolean } => {
    const ok = deleteAccount(id);
    resetVendorTools();
    // The server is gone from the effective config now — this closes it.
    void ensureConnected().catch(() => {});
    return { ok };
  });

  /**
   * Which connectors are waiting on a browser.
   *
   * Asked once at launch (for the banner) and by the Connectors page (so a
   * row shows "Sign in" only when signing in is the thing to do). Connects
   * first, because "has a token" and "the token still works" are different
   * questions and only the second one is worth interrupting the user about.
   */
  ipcMain.handle("connectors:authNeeds", async () => {
    try {
      const { ensureConnected } = await import("../mcp/manager.js");
      await ensureConnected();
    } catch {
      /* a server that cannot start is reported by its own status below */
    }
    const { mcpAuthNeeds } = await import("../connectors/mcp-auth-state.js");
    return mcpAuthNeeds();
  });

  // The cheapest real call proving the stored credential works. Every service
  // carries its own `test` — the field is type-required, because a missing Test
  // branch once reported "works" for a connector that had never been contacted.
  ipcMain.handle(
    "connectors:test",
    async (_e, id: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const resolved = resolveAccount(id);
        if (!resolved) return { ok: false, error: "No such account." };
        const r = await resolved.service.test(resolved);
        return { ok: r.ok, error: r.error };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  // ─── Store (manifests from iaa2005/monet-directory) ─────────────────────
  ipcMain.handle(
    "connectors:storeCatalog",
    async (): Promise<{ entries: CatalogEntry[]; error?: string }> => {
      try {
        return { entries: await fetchCatalog() };
      } catch (e) {
        return {
          entries: [],
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  );

  // Fetch + validate the manifest and report exactly what it talks to — the
  // renderer shows this BEFORE the user confirms an install.
  ipcMain.handle(
    "connectors:storePreview",
    async (
      _e,
      id: string,
    ): Promise<{ ok: boolean; preview?: ManifestPreview; error?: string }> => {
      try {
        return { ok: true, preview: await previewStoreConnector(id) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    "connectors:storeInstall",
    async (_e, id: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        await installStoreConnector(id);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    "connectors:storeRemove",
    (_e, id: string): { ok: boolean; error?: string } => {
      // Block removal if accounts are still connected to this service.
      const linked = listAccounts().filter((a) => a.presetId === id);
      if (linked.length > 0) {
        return {
          ok: false,
          error: `Cannot remove: ${linked.length} account(s) still connected. Disconnect them first.`,
        };
      }
      const ok = removeStoreConnector(id);
      resetVendorTools();
      return { ok };
    },
  );

  ipcMain.handle("connectors:storeInstalled", (): string[] =>
    installedStoreIds(),
  );

  // ─── Google sign-in ──────────────────────────────────────────────────────
  // One call: main runs the consent flow and stores the account, so tokens
  // never reach the renderer and a closed browser tab can't leave a half-made
  // account behind.
  ipcMain.handle(
    "connectors:googleSignIn",
    async (
      _e,
      opts: { presetId: string; clientId: string; clientSecret: string },
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const service = getService(opts.presetId);
        if (service?.auth.kind !== "google-oauth")
          return { ok: false, error: "Not a Google OAuth connector." };
        const { googleSignIn } = await import("../connectors/services/google/auth.js");
        const tokens = await googleSignIn({
          clientId: opts.clientId.trim(),
          clientSecret: opts.clientSecret.trim(),
          scopes: service.auth.scopes,
        });
        // Ask Google who signed in rather than making the user type it: for
        // CalDAV the address IS the principal, so a typo is a dead account.
        let email = "";
        try {
          const { fetchRetry } = await import("../net-fetch.js");
          const r = await fetchRetry(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            { headers: { authorization: `Bearer ${tokens.accessToken}` } },
          );
          email = ((await r.json()) as { email?: string }).email ?? "";
        } catch {
          /* handled below */
        }
        if (!email)
          return {
            ok: false,
            error:
              "Signed in, but Google didn't return your address — the connector can't be addressed without it. Sign in again and make sure the consent screen isn't blocking the email permission.",
          };
        addAccount(
          {
            presetId: opts.presetId,
            username: email,
            secret: {
              clientId: opts.clientId.trim(),
              clientSecret: opts.clientSecret.trim(),
              ...tokens,
            },
          },
          { defaultLabel: service.name },
        );
        resetVendorTools();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  // ─── Remote MCP OAuth sign-in ──────────────────────────────────────────
  // One call: main runs the full OAuth 2.1 flow (discovery + DCR + PKCE +
  // browser consent + token exchange), stores the account, and connects the
  // MCP server. Tokens never reach the renderer.
  ipcMain.handle(
    "connectors:mcpOAuthSignIn",
    async (
      _e,
      opts: { presetId: string },
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const service = getService(opts.presetId);
        if (!service)
          return { ok: false, error: `Unknown connector: ${opts.presetId}` };
        if (!service.capabilities.mcp || !("url" in service.capabilities.mcp))
          return { ok: false, error: "Not a remote MCP OAuth connector." };
        const url = service.capabilities.mcp.url;

        // Create the account first (empty username — filled after we get
        // tokens and can call WhoAmI or similar). Singleton: one server, one
        // token, replacing is the right thing.
        const account = addAccount(
          {
            presetId: opts.presetId,
            username: "",
            secret: {},
          },
          { singleton: true, defaultLabel: service.name },
        );

        const { signInRemoteMcp } = await import(
          "../connectors/lib/mcp-oauth-provider.js"
        );
        await signInRemoteMcp(account.id, url);

        // Bring the server up now so the token is proven.
        void ensureConnected().catch(() => {});
        resetVendorTools();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  // ─── Telegram login (two steps: code → sign-in) ──────────────────────────
  ipcMain.handle(
    "connectors:telegramSendCode",
    async (
      _e,
      opts: { accountId: string; apiId: string; apiHash: string; phone: string },
    ) => {
      const { telegramSendCode } = await import(
        "../connectors/services/telegram/mtproto.js"
      );
      return telegramSendCode(opts);
    },
  );

  ipcMain.handle(
    "connectors:telegramSignIn",
    async (
      _e,
      opts: { accountId: string; code: string; password?: string },
    ) => {
      const { telegramSignIn } = await import("../connectors/services/telegram/mtproto.js");
      const r = await telegramSignIn(opts);
      if (r.ok) resetVendorTools();
      return r;
    },
  );
}
