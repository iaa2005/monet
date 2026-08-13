/**
 * On-screen UI element detection for Computer Use — Windows UI Automation via
 * PowerShell, no native build and no ML model needed: names, control types and
 * bounding boxes straight from the accessibility tree of the foreground
 * window. Chromium apps build their a11y tree lazily on the first UIA query,
 * so an empty first pass is retried.
 */

import { spawn } from "child_process";

export interface UiElement {
  /** Accessible name (or automation id). */
  n: string;
  /** Control type, e.g. Button / Edit / Hyperlink / ListItem. */
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UiElementsResult {
  ok: boolean;
  title?: string;
  elements?: UiElement[];
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
}
"@
$h = [MonetFg]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) { [Console]::Out.WriteLine('{"error":"no foreground window"}'); exit 0 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
$title = $root.Current.Name
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsOffscreenProperty, $false)
$keep = @('Button','Hyperlink','Edit','ComboBox','CheckBox','RadioButton','ListItem','MenuItem','TabItem','TreeItem','SplitButton','Slider','Document')
$out = New-Object System.Collections.Generic.List[object]
# Chromium exposes its a11y tree lazily — poke, wait, retry when empty.
for ($attempt = 0; $attempt -lt 3 -and $out.Count -eq 0; $attempt++) {
  if ($attempt -gt 0) { Start-Sleep -Milliseconds (300 * $attempt) }
  $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  foreach ($el in $els) {
    if ($out.Count -ge 150) { break }
    try {
      $c = $el.Current
      $t = $c.ControlType.ProgrammaticName -replace '^ControlType\\.',''
      if ($keep -notcontains $t) { continue }
      $r = $c.BoundingRectangle
      if ([double]::IsInfinity($r.Width) -or $r.Width -le 1 -or $r.Height -le 1) { continue }
      $name = $c.Name
      if ([string]::IsNullOrWhiteSpace($name)) { $name = $c.AutomationId }
      if ([string]::IsNullOrWhiteSpace($name) -and $t -ne 'Edit' -and $t -ne 'Document') { continue }
      if ($name.Length -gt 80) { $name = $name.Substring(0,80) }
      $out.Add(@{ n = $name; t = $t; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height })
    } catch { continue }
  }
}
$res = @{ title = $title; elements = $out }
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

export async function listScreenElements(): Promise<UiElementsResult> {
  const r = await runJsonPs<{
    error?: string;
    title?: string;
    elements?: UiElement[] | UiElement | null;
  }>(SCRIPT, 15_000);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.value.error) return { ok: false, error: r.value.error };
  // ConvertTo-Json collapses a 1-element list to a bare object.
  const els = Array.isArray(r.value.elements)
    ? r.value.elements
    : r.value.elements
      ? [r.value.elements]
      : [];
  return { ok: true, title: r.value.title, elements: els };
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
  const r = await runJsonPs<TopWindow[] | TopWindow | null>(
    WINDOWS_SCRIPT,
    10_000,
  );
  if (!r.ok) return [];
  return Array.isArray(r.value) ? r.value : r.value ? [r.value] : [];
}
