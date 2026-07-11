/**
 * Mouse/keyboard control for Computer Use — via PowerShell + Win32
 * (user32.dll), so there is NO native dependency to build.
 *
 * Coordinates are DIP screen pixels (see screen.ts). Text is passed to
 * PowerShell base64-encoded to avoid any quoting/escaping issues, and typed by
 * pasting through the clipboard (reliable for Unicode incl. Cyrillic); the
 * previous clipboard text is saved and restored.
 */

import { spawn } from "child_process";

function ps(script: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", "-"],
      { windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ ok: false, stdout, stderr: e.message }));
    child.on("close", (code) =>
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }),
    );
    child.stdin.write(script);
    child.stdin.end();
  });
}

// Shared Win32 P/Invoke surface prepended to every script.
const WIN32 = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MonetInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, IntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
}
"@
`;

const M = {
  LEFTDOWN: 0x02,
  LEFTUP: 0x04,
  RIGHTDOWN: 0x08,
  RIGHTUP: 0x10,
  MIDDLEDOWN: 0x20,
  MIDDLEUP: 0x40,
  WHEEL: 0x0800,
};

export async function moveMouse(x: number, y: number): Promise<void> {
  await ps(`${WIN32}\n[MonetInput]::SetCursorPos(${x}, ${y}) | Out-Null`);
}

export async function click(
  x: number,
  y: number,
  button: "left" | "right" | "middle" = "left",
  double = false,
): Promise<void> {
  const [down, up] =
    button === "right"
      ? [M.RIGHTDOWN, M.RIGHTUP]
      : button === "middle"
        ? [M.MIDDLEDOWN, M.MIDDLEUP]
        : [M.LEFTDOWN, M.LEFTUP];
  const oneClick = `[MonetInput]::mouse_event(${down},0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 30; [MonetInput]::mouse_event(${up},0,0,0,[IntPtr]::Zero)`;
  await ps(
    `${WIN32}\n[MonetInput]::SetCursorPos(${x}, ${y}) | Out-Null; Start-Sleep -Milliseconds 40;\n${oneClick}${double ? `; Start-Sleep -Milliseconds 60;\n${oneClick}` : ""}`,
  );
}

export async function scroll(
  x: number,
  y: number,
  direction: "up" | "down",
  clicks = 3,
): Promise<void> {
  const amount = (direction === "up" ? 1 : -1) * clicks * 120;
  await ps(
    `${WIN32}\n[MonetInput]::SetCursorPos(${x}, ${y}) | Out-Null; [MonetInput]::mouse_event(${M.WHEEL},0,0,${amount},[IntPtr]::Zero)`,
  );
}

export async function typeText(text: string): Promise<void> {
  const b64 = Buffer.from(text, "utf-8").toString("base64");
  await ps(
    `${WIN32}
$saved = ''
try { $saved = Get-Clipboard -Raw } catch {}
$txt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
Set-Clipboard -Value $txt
Start-Sleep -Milliseconds 40
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 120
try { if ($saved) { Set-Clipboard -Value $saved } } catch {}`,
  );
}

// Model key names → SendKeys tokens.
const KEY_MAP: Record<string, string> = {
  enter: "{ENTER}",
  return: "{ENTER}",
  tab: "{TAB}",
  esc: "{ESC}",
  escape: "{ESC}",
  space: " ",
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  del: "{DELETE}",
  home: "{HOME}",
  end: "{END}",
  pageup: "{PGUP}",
  page_up: "{PGUP}",
  pagedown: "{PGDN}",
  page_down: "{PGDN}",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
};

/** Convert "ctrl+c", "alt+Tab", "Return" → a SendKeys string. */
function toSendKeys(combo: string): string {
  const parts = combo.split("+").map((p) => p.trim().toLowerCase());
  let prefix = "";
  const keys: string[] = [];
  for (const p of parts) {
    if (p === "ctrl" || p === "control" || p === "cmd" || p === "meta")
      prefix += "^";
    else if (p === "alt" || p === "option") prefix += "%";
    else if (p === "shift") prefix += "+";
    else keys.push(KEY_MAP[p] ?? p);
  }
  return prefix + keys.join("");
}

export async function pressKey(combo: string): Promise<void> {
  const sk = toSendKeys(combo).replace(/'/g, "''");
  await ps(`${WIN32}\n[System.Windows.Forms.SendKeys]::SendWait('${sk}')`);
}

export async function cursorPosition(): Promise<{ x: number; y: number }> {
  const r = await ps(
    `${WIN32}\n$p = New-Object MonetInput+P; [MonetInput]::GetCursorPos([ref]$p) | Out-Null; Write-Output "$($p.X),$($p.Y)"`,
  );
  const [x, y] = r.stdout.split(",").map((n) => parseInt(n, 10));
  return { x: x || 0, y: y || 0 };
}

/** Foreground window's process name (lower-case, no extension), for the
 * Denied-apps gate. Empty string when it can't be determined. */
export async function foregroundApp(): Promise<string> {
  const r = await ps(
    `${WIN32}
$pid = 0
$h = [MonetInput]::GetForegroundWindow()
[MonetInput]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null
try { (Get-Process -Id $pid).ProcessName } catch { '' }`,
  );
  return r.stdout.trim().toLowerCase();
}
