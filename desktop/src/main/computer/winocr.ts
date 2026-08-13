/**
 * Text for the vision fallback — Windows' own OCR, no model to download.
 *
 * OmniParser's boxes say WHERE the interactive things are but not what they
 * say; a blind model needs the words. Windows.Media.Ocr ships with the OS,
 * reads the user's profile languages (Russian included, which is exactly the
 * weak spot of most small OCR models), and does a full screenshot in about a
 * tenth of a second. Driven from PowerShell over WinRT — the classic
 * AsTask-await bridge, since PS 5.1 cannot `await` an IAsyncOperation.
 *
 * -EncodedCommand, never `-Command -` + stdin: the stdin path silently
 * executes nothing for multi-line scripts (see input.ts ps()).
 */

import { spawn } from "child_process";

export interface OcrLine {
  /** The line's text. */
  t: string;
  /** Bounding box in the IMAGE's pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

// The backtick in IAsyncOperation`1 is inside single quotes — literal for PS.
const SCRIPT_TEMPLATE = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation.UniversalApiContract, ContentType=WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  $null = $task.Wait(-1)
  $task.Result
}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { Write-Output '{"error":"no OCR engine for the profile languages"}'; exit 0 }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('__PATH__')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
$lines = @($res.Lines | ForEach-Object {
  $x1 = [double]::MaxValue; $y1 = [double]::MaxValue; $x2 = 0.0; $y2 = 0.0
  foreach ($w in $_.Words) {
    $r = $w.BoundingRect
    if ($r.X -lt $x1) { $x1 = $r.X }
    if ($r.Y -lt $y1) { $y1 = $r.Y }
    if (($r.X + $r.Width) -gt $x2) { $x2 = $r.X + $r.Width }
    if (($r.Y + $r.Height) -gt $y2) { $y2 = $r.Y + $r.Height }
  }
  @{ t = $_.Text; x = [int]$x1; y = [int]$y1; w = [int]($x2 - $x1); h = [int]($y2 - $y1) }
})
ConvertTo-Json -Compress -InputObject $lines
`;

/** OCR a PNG on disk. Returns [] when the engine is missing or reading fails —
 * the vision fallback still has its boxes, just without words. */
export function readImageText(pngPath: string): Promise<OcrLine[]> {
  const script = SCRIPT_TEMPLATE.replace("__PATH__", pngPath.replace(/'/g, "''"));
  return new Promise((resolve) => {
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
    let done = false;
    const finish = (lines: OcrLine[]): void => {
      if (!done) {
        done = true;
        resolve(lines);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish([]);
    }, 15_000);
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      finish([]);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const line = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .pop();
        if (!line) return finish([]);
        const parsed = JSON.parse(line) as
          | OcrLine[]
          | OcrLine
          | { error?: string }
          | null;
        if (!parsed || (typeof parsed === "object" && "error" in parsed))
          return finish([]);
        finish(Array.isArray(parsed) ? parsed : [parsed as OcrLine]);
      } catch {
        finish([]);
      }
    });
  });
}
