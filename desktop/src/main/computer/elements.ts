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

export function listScreenElements(): Promise<UiElementsResult> {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", "-"],
      { windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r: UiElementsResult): void => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: "UI element scan timed out (15s)" });
    }, 15_000);
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: e.message });
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        // The JSON is the last non-empty stdout line (Add-Type may chat).
        const line = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .pop();
        if (!line) return finish({ ok: false, error: stderr || "no output" });
        const parsed = JSON.parse(line) as {
          error?: string;
          title?: string;
          elements?: UiElement[] | UiElement | null;
        };
        if (parsed.error) return finish({ ok: false, error: parsed.error });
        // ConvertTo-Json collapses a 1-element list to a bare object.
        const els = Array.isArray(parsed.elements)
          ? parsed.elements
          : parsed.elements
            ? [parsed.elements]
            : [];
        finish({ ok: true, title: parsed.title, elements: els });
      } catch (e) {
        finish({
          ok: false,
          error: e instanceof Error ? e.message : "parse failed",
        });
      }
    });
    child.stdin.write(SCRIPT);
    child.stdin.end();
  });
}
