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
    // -EncodedCommand, NOT `-Command -` + stdin: the stdin path parses the
    // script REPL-style, and a multi-line body (every script here — the WIN32
    // Add-Type block spans lines) silently runs NOTHING and exits 0. Verified
    // live: `Write-Output 'hi'` came through, any multi-line script came back
    // empty. Encoded, the whole script is one command and multi-line just works.
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
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
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
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
  const result = await ps(
    `${WIN32}
$saved = ''
try { $saved = Get-Clipboard -Raw } catch {}
$txt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
Set-Clipboard -Value $txt
Start-Sleep -Milliseconds 150
[MonetInput]::keybd_event(0xA2,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[MonetInput]::keybd_event(0x56,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[MonetInput]::keybd_event(0x56,0,2,[UIntPtr]::Zero)
[MonetInput]::keybd_event(0xA2,0,2,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 300
try { Set-Clipboard -Value $saved } catch {}`,
  );
  if (!result.ok) throw new Error(result.stderr || "Text input failed");
}

const KEY_VK: Record<string, number> = {
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  esc: 0x1b,
  escape: 0x1b,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  page_up: 0x21,
  pagedown: 0x22,
  page_down: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  ctrl: 0xa2,
  control: 0xa2,
  cmd: 0x5b,
  meta: 0x5b,
  win: 0x5b,
  windows: 0x5b,
  super: 0x5b,
  alt: 0xa4,
  option: 0xa4,
  shift: 0xa0,
};

function keyCode(key: string): number {
  const normalized = key.trim().toLowerCase();
  if (KEY_VK[normalized] !== undefined) return KEY_VK[normalized];
  if (normalized.length === 1) return normalized.toUpperCase().charCodeAt(0);
  throw new Error(`Unsupported key: ${key}`);
}

/** Send a key combination as real key-down/key-up events. */
export async function pressKey(combo: string): Promise<void> {
  const keys = combo.split("+").map(keyCode);
  const downs = keys.map((key) => `[MonetInput]::keybd_event(${key},0,0,[UIntPtr]::Zero)`).join("; ");
  const ups = [...keys].reverse().map((key) => `[MonetInput]::keybd_event(${key},0,2,[UIntPtr]::Zero)`).join("; ");
  const result = await ps(`${WIN32}\n${downs}; Start-Sleep -Milliseconds 40; ${ups}`);
  if (!result.ok) throw new Error(result.stderr || "Key press failed");
}

export async function cursorPosition(): Promise<{ x: number; y: number }> {
  const r = await ps(
    `${WIN32}\n$p = New-Object MonetInput+P; [MonetInput]::GetCursorPos([ref]$p) | Out-Null; Write-Output "$($p.X),$($p.Y)"`,
  );
  const [x, y] = r.stdout.split(",").map((n) => parseInt(n, 10));
  return { x: x || 0, y: y || 0 };
}

/** Bring the first window whose title contains `title` (case-insensitive) to
 * the foreground, restoring it if minimized. Returns the matched full title,
 * or null when nothing matched. */
export async function focusWindow(title: string): Promise<string | null> {
  const b64 = Buffer.from(title, "utf-8").toString("base64");
  const r = await ps(
    `${WIN32}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')).ToLower()
$p = Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.ToLower().Contains($t) } | Select-Object -First 1
if (-not $p) { Write-Output '<<NOTFOUND>>'; exit 0 }
$h = $p.MainWindowHandle
if ([MonetInput]::IsIconic($h)) { [MonetInput]::ShowWindow($h, 9) | Out-Null }
# A background process may not steal focus; a synthetic Alt tap lifts the
# foreground lock (the classic SetForegroundWindow workaround).
[MonetInput]::keybd_event(0xA4,0,0,[UIntPtr]::Zero)
[MonetInput]::keybd_event(0xA4,0,2,[UIntPtr]::Zero)
[MonetInput]::SetForegroundWindow($h) | Out-Null
Write-Output $p.MainWindowTitle`,
  );
  const out = r.stdout.trim();
  if (!r.ok || !out || out.includes("<<NOTFOUND>>")) return null;
  return out.split("\n").pop()!.trim();
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
