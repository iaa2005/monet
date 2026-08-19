/**
 * On-screen UI element detection for Computer Use — Windows UI Automation via
 * PowerShell, no native build and no ML model needed: names, control types and
 * bounding boxes straight from the accessibility tree of the foreground
 * window. Chromium apps build their a11y tree lazily on the first UIA query,
 * so an empty first pass is retried.
 */

import { spawn } from "child_process";
import { screen } from "electron";

export interface UiElement {
  /** Accessible name (or automation id). */
  n: string;
  /** Control type, e.g. Button / Edit / Hyperlink / ListItem. */
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Office-style Alt accelerator (UIA AccessKey), when the control has one. */
  k?: string;
}

export interface UiElementsResult {
  ok: boolean;
  title?: string;
  /** Process that owns the foreground window, lower-case, no extension. */
  app?: string;
  elements?: UiElement[];
  /** Titles of open modal child windows (dialogs) — the thing every click
   * bounces off with an error chime until it is dealt with. */
  dialogs?: string[];
  /** The keyboard-focused element right now, when UIA can name one. */
  focused?: UiElement | null;
  error?: string;
}

const SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MonetFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
}
"@
# PER_MONITOR_AWARE_V2: rects must be PHYSICAL pixels, not virtualised ones —
# the TS side converts them to DIP once, through electron's own screen math.
[MonetFg]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$h = [MonetFg]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) { [Console]::Out.WriteLine('{"error":"no foreground window"}'); exit 0 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
$title = $root.Current.Name
# Whose window this is, taken HERE — from the same GetForegroundWindow call
# that produced the tree. A separate probe raced these scans (Add-Type can
# flash a console) and reported "powershell" as the app the model was looking
# at, after which every keystroke was refused as aimed at the wrong window.
$app = ''
try { $app = (Get-Process -Id $root.Current.ProcessId).ProcessName.ToLower() } catch {}
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsOffscreenProperty, $false)
$keep = @('Button','Hyperlink','Edit','ComboBox','CheckBox','RadioButton','ListItem','MenuItem','TabItem','TreeItem','SplitButton','Slider','Document','DataItem','HeaderItem')

function Read-El($el) {
  $c = $el.Current
  $t = $c.ControlType.ProgrammaticName -replace '^ControlType\\.',''
  if ($keep -notcontains $t) { return $null }
  $r = $c.BoundingRectangle
  if ([double]::IsInfinity($r.Width) -or $r.Width -le 1 -or $r.Height -le 1) { return $null }
  $name = $c.Name
  if ([string]::IsNullOrWhiteSpace($name)) { $name = $c.AutomationId }
  if ([string]::IsNullOrWhiteSpace($name) -and $t -ne 'Edit' -and $t -ne 'Document') { return $null }
  if ($name.Length -gt 80) { $name = $name.Substring(0,80) }
  $o = @{ n = $name; t = $t; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
  # Office ribbons publish their Alt accelerators here — the reliable way to
  # drive them blind, immune to DPI and layout.
  $ak = $c.AccessKey
  if (-not [string]::IsNullOrWhiteSpace($ak)) { $o.k = $ak }
  return $o
}

# Modal child windows FIRST, into their own list: while one is open every
# click elsewhere bounces off with the error chime, so the model must see it
# before anything else — and a huge host window (Excel) must not crowd it out.
$dialogs = New-Object System.Collections.Generic.List[string]
$dout = New-Object System.Collections.Generic.List[object]
$winCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
try {
  $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
  foreach ($dlg in $children) {
    try {
      $dialogs.Add($dlg.Current.Name)
      $dels = $dlg.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
      foreach ($el in $dels) {
        if ($dout.Count -ge 100) { break }
        try { $o = Read-El $el; if ($o) { $dout.Add($o) } } catch { continue }
      }
    } catch { continue }
  }
} catch {}

# The keyboard focus — one line that tells the model where typing will land.
$focused = $null
try {
  $f = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($f) { $focused = Read-El $f }
} catch {}

# The window itself. Collect generously — 600, not 150: the old cap filled up
# with whatever the tree walk met first (Excel: the status bar) and the parts
# that matter never made the list. The TS side ranks, dedupes the dialog
# children this walk sees again, and trims.
# Chromium exposes its a11y tree lazily — poke, wait, retry when empty.
$out = New-Object System.Collections.Generic.List[object]
for ($attempt = 0; $attempt -lt 3 -and $out.Count -eq 0; $attempt++) {
  if ($attempt -gt 0) { Start-Sleep -Milliseconds (300 * $attempt) }
  $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  foreach ($el in $els) {
    if ($out.Count -ge 600) { break }
    try { $o = Read-El $el; if ($o) { $out.Add($o) } } catch { continue }
  }
}
$res = @{ title = $title; app = $app; dialogEls = $dout; elements = $out; dialogs = $dialogs; focused = $focused }
[Console]::Out.WriteLine(($res | ConvertTo-Json -Compress -Depth 4))
`;

/** Run a PowerShell script and parse its last non-empty stdout line as JSON
 * (Add-Type may chat on earlier lines). */
function runJsonPs<T>(
  script: string,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    // -EncodedCommand, NOT `-Command -` + stdin — the stdin path silently
    // executes nothing for multi-line scripts (see input.ts ps()).
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
    let done = false;
    const finish = (
      r: { ok: true; value: T } | { ok: false; error: string },
    ): void => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: `scan timed out (${timeoutMs / 1000}s)` });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: e.message });
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const line = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .pop();
        if (!line) return finish({ ok: false, error: stderr || "no output" });
        finish({ ok: true, value: JSON.parse(line) as T });
      } catch (e) {
        finish({
          ok: false,
          error: e instanceof Error ? e.message : "parse failed",
        });
      }
    });
  });
}

/** ConvertTo-Json collapses a 1-element list to a bare object. */
function asList<T>(v: T[] | T | null | undefined): T[] {
  return Array.isArray(v) ? v : v ? [v] : [];
}

/**
 * What to show first when the list must be cut. Fields and inputs, then the
 * things one clicks, then navigation, then content rows. Excel's thousand
 * status-bar descendants were winning on tree order alone; usefulness is not
 * tree order.
 */
const TYPE_RANK: Record<string, number> = {
  Edit: 0,
  ComboBox: 1,
  Button: 2,
  SplitButton: 2,
  TabItem: 3,
  MenuItem: 3,
  CheckBox: 4,
  RadioButton: 4,
  Hyperlink: 5,
  ListItem: 6,
  TreeItem: 6,
  DataItem: 6,
  HeaderItem: 7,
  Slider: 7,
  Document: 8,
};

/** How many ranked elements the model is shown. */
const REPORT_CAP = 180;

/**
 * macOS: the Swift helper walks the frontmost app's Accessibility tree and
 * answers in the same shape the PowerShell/UIA script does — same type names
 * (mapped in the helper), same dialog-first contract. One real difference:
 * AX coordinates are already points (= DIP), so no screenToDipRect pass.
 */
async function listScreenElementsMac(): Promise<UiElementsResult> {
  const { runMac, macPermissions } = await import("./mac.js");
  const r = await runMac(["elements"], 20_000);
  if (!r.ok) return { ok: false, error: r.stderr || "The accessibility scan failed." };
  let v: {
    error?: string;
    title?: string;
    app?: string;
    elements?: UiElement[];
    dialogEls?: UiElement[];
    dialogs?: string[];
    focused?: UiElement | null;
  };
  try {
    v = JSON.parse(r.stdout);
  } catch {
    return { ok: false, error: "The accessibility scan returned malformed data." };
  }
  if (v.error === "accessibility-not-granted") {
    const perms = await macPermissions();
    return {
      ok: false,
      error:
        "macOS has not granted this app Accessibility access. Enable it in " +
        "System Settings → Privacy & Security → Accessibility, then retry." +
        (perms.screen ? "" : " (Screen Recording is also off — window titles and screenshots need it.)"),
    };
  }
  if (v.error) return { ok: false, error: v.error };

  const dialogEls = asList(v.dialogEls);
  const ranked = asList(v.elements).sort((a, b) => {
    const ra = TYPE_RANK[a.t] ?? 9;
    const rb = TYPE_RANK[b.t] ?? 9;
    if (ra !== rb) return ra - rb;
    return Math.abs(a.y - b.y) > 12 ? a.y - b.y : a.x - b.x;
  });
  const seen = new Set(dialogEls.map((e) => `${e.t}|${e.n}|${e.x}|${e.y}`));
  const merged = [
    ...dialogEls,
    ...ranked.filter((e) => !seen.has(`${e.t}|${e.n}|${e.x}|${e.y}`)),
  ].slice(0, REPORT_CAP);

  return {
    ok: true,
    title: v.title,
    app: v.app || undefined,
    elements: merged,
    dialogs: asList(v.dialogs).filter(Boolean),
    focused: v.focused ?? null,
  };
}

export async function listScreenElements(): Promise<UiElementsResult> {
  if (process.platform === "darwin") return listScreenElementsMac();
  const r = await runJsonPs<{
    error?: string;
    title?: string;
    app?: string;
    elements?: UiElement[] | UiElement | null;
    dialogEls?: UiElement[] | UiElement | null;
    dialogs?: string[] | string | null;
    focused?: UiElement | null;
  }>(SCRIPT, 15_000);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.value.error) return { ok: false, error: r.value.error };

  // UIA speaks physical pixels; the tool's whole coordinate space is DIP
  // (screenshots, the vision fallback, Electron's own screen API). Convert
  // at the edge, once — on a 175% display the two differ by 1.75x, which was
  // enough to land every ribbon click in the wrong control.
  const toDip = (e: UiElement): UiElement => {
    const r2 = screen.screenToDipRect(null, {
      x: e.x,
      y: e.y,
      width: e.w,
      height: e.h,
    });
    return { ...e, x: r2.x, y: r2.y, w: r2.width, h: r2.height };
  };

  const dialogEls = asList(r.value.dialogEls).map(toDip);
  // Rank the window's own elements by usefulness, keep reading order inside
  // a rank. The dialog's elements go FIRST unconditionally — while it is
  // open, they are the only clicks that do anything.
  const ranked = asList(r.value.elements)
    .map(toDip)
    .sort((a, b) => {
      const ra = TYPE_RANK[a.t] ?? 9;
      const rb = TYPE_RANK[b.t] ?? 9;
      if (ra !== rb) return ra - rb;
      return Math.abs(a.y - b.y) > 12 ? a.y - b.y : a.x - b.x;
    });
  // The main walk sees the dialog's children again — drop the copies.
  const seen = new Set(dialogEls.map((e) => `${e.t}|${e.n}|${e.x}|${e.y}`));
  const merged = [
    ...dialogEls,
    ...ranked.filter((e) => !seen.has(`${e.t}|${e.n}|${e.x}|${e.y}`)),
  ].slice(0, REPORT_CAP);

  return {
    ok: true,
    title: r.value.title,
    app: r.value.app || undefined,
    elements: merged,
    dialogs: asList(r.value.dialogs).filter(Boolean),
    focused: r.value.focused ? toDip(r.value.focused) : null,
  };
}

export interface TopWindow {
  /** Process name, e.g. "chrome". */
  app: string;
  title: string;
}

const WINDOWS_SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$list = @(Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object {
  @{ app = $_.ProcessName; title = $_.MainWindowTitle }
})
ConvertTo-Json -Compress -InputObject $list
`;

/** Every process with a visible top-level window — the app-switching map for
 * a model that cannot see the taskbar. */
export async function listTopWindows(): Promise<TopWindow[]> {
  if (process.platform === "darwin") {
    const { runMac } = await import("./mac.js");
    const r = await runMac(["windows"], 10_000);
    try {
      const v = JSON.parse(r.stdout) as TopWindow[];
      return Array.isArray(v) ? v.filter((w) => w.app || w.title) : [];
    } catch {
      return [];
    }
  }
  const r = await runJsonPs<TopWindow[] | TopWindow | null>(
    WINDOWS_SCRIPT,
    10_000,
  );
  if (!r.ok) return [];
  return Array.isArray(r.value) ? r.value : r.value ? [r.value] : [];
}
