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
import type { ConnectorAccount, ConnectorSecret } from "../connectors/types.js";

export function registerConnectorsIPC(): void {
  ipcMain.handle("connectors:presets", () => PRESETS);
  ipcMain.handle("connectors:list", (): ConnectorAccount[] => listAccounts());

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
      return row;
    },
  );

  ipcMain.handle("connectors:delete", (_e, id: string): { ok: boolean } => {
    const ok = deleteAccount(id);
    resetVendorTools();
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

        if (preset.protocols.includes("imap")) {
          const r = await mailFolders(pickAccount("imap", id));
          return { ok: r.ok, error: r.error };
        }
        if (preset.protocols.includes("webdav")) {
          const r = await filesList(pickAccount("webdav", id), { path: "/" });
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
