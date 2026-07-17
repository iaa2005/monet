/**
 * Connectors IPC — presets, accounts, and the Telegram login handshake.
 *
 * Secrets travel renderer→main only (to be encrypted and stored); nothing here
 * ever sends one back out, so a compromised renderer can't read them back.
 */

import { ipcMain } from "electron";
import {
  PRESETS,
  addAccount,
  deleteAccount,
  listAccounts,
  pickAccount,
  updateAccount,
} from "../connectors/index.js";
import { resetVendorTools } from "../agent/vendor-tools.js";
import {
  telegramSendCode,
  telegramSignIn,
} from "../connectors/protocols/telegram.js";
import { mailFolders } from "../connectors/protocols/mail.js";
import { filesList } from "../connectors/protocols/files.js";
import { calendarList } from "../connectors/protocols/dav.js";
import { getPreset } from "../connectors/presets.js";
import {
  ensureConnected,
  getConnectorServerStatus,
  loadConfig,
} from "../mcp/manager.js";
import type { ConnectorAccount, ConnectorSecret } from "../connectors/types.js";

export function registerConnectorsIPC(): void {
  ipcMain.handle("connectors:presets", () => PRESETS);
  ipcMain.handle("connectors:list", (): ConnectorAccount[] => listAccounts());

  /**
   * Everything a routine can be scoped to, in one list: connector accounts plus
   * any hand-written MCP server. Routines used to read mcp.list() directly,
   * which silently went empty once connectors stopped living in that file.
   * The id is what a routine stores — a preset id for a connector, the server
   * name for a raw MCP server; both are what the tool scoping matches on.
   */
  ipcMain.handle(
    "connectors:options",
    (): { id: string; label: string; kind: "connector" | "mcp" }[] => {
      const out: { id: string; label: string; kind: "connector" | "mcp" }[] = [];
      const seen = new Set<string>();
      for (const a of listAccounts()) {
        if (!a.enabled || seen.has(a.presetId)) continue;
        seen.add(a.presetId);
        out.push({ id: a.presetId, label: a.label, kind: "connector" });
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
      const account = addAccount(input);
      resetVendorTools(); // tool advertisement depends on which accounts exist
      // MCP-backed connector: bring its server up now, so the token is proven
      // (or the error surfaced) while the user is still looking at the form.
      if (getPreset(input.presetId)?.mcp) void ensureConnected().catch(() => {});
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

  ipcMain.handle("connectors:delete", (_e, id: string): { ok: boolean } => {
    const ok = deleteAccount(id);
    resetVendorTools();
    // The server is gone from the effective config now — this closes it.
    void ensureConnected().catch(() => {});
    return { ok };
  });

  // Prove the credentials work, using each protocol's cheapest real call —
  // better to fail here, in a form the user is looking at, than inside a tool
  // call three turns later.
  ipcMain.handle(
    "connectors:test",
    async (_e, id: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const rows = listAccounts();
        const account = rows.find((a) => a.id === id);
        if (!account) return { ok: false, error: "No such account." };
        const preset = getPreset(account.presetId);
        if (!preset) return { ok: false, error: "Unknown connector." };

        if (preset.mcp) {
          // Spawning the server IS the test: it fails loudly on a bad token.
          await ensureConnected();
          const s = getConnectorServerStatus(account.presetId);
          if (!s) return { ok: false, error: "Server did not start." };
          return s.status === "connected"
            ? { ok: true }
            : { ok: false, error: s.error ?? `Server is ${s.status}.` };
        }
        if (preset.protocols.includes("imap")) {
          const r = await mailFolders(pickAccount("imap", id));
          return { ok: r.ok, error: r.error };
        }
        if (preset.protocols.includes("webdav")) {
          const r = await filesList(pickAccount("webdav", id), { path: "/" });
          return { ok: r.ok, error: r.error };
        }
        if (preset.protocols.includes("gdrive")) {
          const { driveList } = await import("../connectors/protocols/gdrive.js");
          const r = await driveList(pickAccount("gdrive", id), { path: "/" });
          return { ok: r.ok, error: r.error };
        }
        if (preset.protocols.includes("caldav")) {
          const r = await calendarList(pickAccount("caldav", id));
          return { ok: r.ok, error: r.error };
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  // ─── Google sign-in ──────────────────────────────────────────────────────
  // Runs the consent flow, then stores the account. Deliberately one call: the
  // tokens never reach the renderer, and a half-made account can't be left
  // behind if the user closes the browser tab.
  ipcMain.handle(
    "connectors:googleSignIn",
    async (
      _e,
      opts: { presetId: string; clientId: string; clientSecret: string },
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const preset = getPreset(opts.presetId);
        if (!preset?.oauth) return { ok: false, error: "Not an OAuth connector." };
        const { googleSignIn } = await import("../connectors/oauth/google.js");
        const tokens = await googleSignIn({
          clientId: opts.clientId.trim(),
          clientSecret: opts.clientSecret.trim(),
          scopes: preset.oauth.scopes,
        });
        // Ask Google who just signed in, rather than making the user type it:
        // the address IS the CalDAV principal, so a typo here is a dead account.
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
        // Refuse rather than store a login-less account: for CalDAV the address
        // IS the principal, so an empty one signs in fine and then fails with a
        // baffling "cannot find homeUrl" days later.
        if (!email)
          return {
            ok: false,
            error:
              "Signed in, but Google didn't return your address — the connector can't be addressed without it. Sign in again and make sure the consent screen isn't blocking the email permission.",
          };
        addAccount({
          presetId: opts.presetId,
          username: email,
          secret: {
            clientId: opts.clientId.trim(),
            clientSecret: opts.clientSecret.trim(),
            ...tokens,
          },
        });
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
    (
      _e,
      opts: { accountId: string; apiId: string; apiHash: string; phone: string },
    ) => telegramSendCode(opts),
  );

  ipcMain.handle(
    "connectors:telegramSignIn",
    async (
      _e,
      opts: { accountId: string; code: string; password?: string },
    ) => {
      const r = await telegramSignIn(opts);
      if (r.ok) resetVendorTools();
      return r;
    },
  );
}
