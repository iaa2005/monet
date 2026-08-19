/**
 * Computer Use tool (Code space) — screenshot + mouse/keyboard control of the
 * real desktop, following Anthropic's `computer` tool shape.
 *
 * The model works visually: it takes a screenshot (returned as an image block
 * it can SEE), then acts by coordinate in that image's pixel space. Screenshots
 * are downscaled to a model-friendly width; the engine maps coordinates back to
 * real screen pixels. Requires a multimodal model — gated in vendor-tools by
 * the active model's `image` modality + the Computer Use setting.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { screen } from "electron";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "../engine/Tool.js";
import { lazySchema } from "./lazy-schema.js";
import { captureScreen, toScreenCoord } from "../computer/screen.js";
import { listScreenElements, listTopWindows } from "../computer/elements.js";
import {
  click,
  cursorPosition,
  focusWindow,
  foregroundApp,
  launchApp,
  moveMouse,
  pressKey,
  scroll,
  typeText,
} from "../computer/input.js";
import { activeModelAccepts } from "./model-modalities.js";
import { getComputerConfig } from "../computer/config.js";
import { touchComputerOverlay } from "../computer/overlay.js";
import { visionScreenElements } from "../computer/vision.js";

/**
 * Are window titles readable at all?
 *
 * macOS hands out kCGWindowName only to an app with Screen Recording; without
 * it every title is the empty string, which is indistinguishable from "no
 * match" unless someone asks. Windows has no such gate, so this is false
 * there and the ordinary message stands.
 */
async function titlesAreBlind(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    const { macPermissions } = await import("../computer/mac.js");
    return !(await macPermissions()).screen;
  } catch {
    return false;
  }
}
import { getMainWindow } from "../app/main-window.js";
import { artifactReference, saveArtifactBuffer } from "../ipc/artifacts.js";

// The transform from the most recent screenshot to virtual desktop pixels.
let lastTransform = {
  scaleX: 1,
  scaleY: 1,
  offsetX: 0,
  offsetY: 0,
};

/** The foreground process at the last look (screenshot / list_elements /
 * focus_window / launch_app). Typing is only honest while it still holds:
 * a target that closed mid-run turned "Typed 6 chars" into keystrokes
 * sprayed at whatever window came next — reported as success. */
let lastSeenApp: string | null = null;

/** Processes this tool spawns to look at the screen. They can briefly own the
 * foreground (Add-Type compiles, and csc flashes a console), and one of them
 * being mistaken for the target is what refused every keystroke in a live
 * session with "it is now excel, not powershell". */
const HELPER_PROCESSES = new Set([
  "powershell", "pwsh", "conhost", "csc", "cvtres",
  // macOS: the compiled Swift helper, and the terminal it may run under in dev.
  "monet-mac", "terminal", "iterm2",
]);

interface ComputerOutput {
  text: string;
  isError: boolean;
  imageBase64?: string;
  imageMediaType?: string;
}

const schema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum([
        "screenshot",
        "list_elements",
        "focus_window",
        "launch_app",
        "left_click",
        "right_click",
        "middle_click",
        "double_click",
        "mouse_move",
        "type",
        "key",
        "scroll",
        "cursor_position",
      ])
      .describe("The action to perform."),
    coordinate: z
      .array(z.number())
      .optional()
      .describe("[x, y] in the LAST screenshot's pixel space (for clicks/move/scroll)."),
    text: z
      .string()
      .optional()
      .describe(
        "Text to type (action=type), a key combo like 'ctrl+c' / 'cmd+c', 'Return' (action=key), part of a window title (action=focus_window), or an app's name (action=launch_app).",
      ),
    scroll_direction: z.enum(["up", "down"]).optional(),
    scroll_amount: z.number().optional().describe("Wheel clicks (default 3)."),
    region: z
      .union([
        z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
        // Models guess [x, y, width, height] about as often as the object —
        // a real session burned a turn on the validation error. Take both.
        z.tuple([z.number(), z.number(), z.number(), z.number()]),
      ])
      .optional()
      .describe(
        "Optional screen crop for screenshot: {x, y, width, height} or [x, y, width, height].",
      ),
  }),
);
type Schema = ReturnType<typeof schema>;

/** Whether the active model can see images. Without vision the tool switches
 * to BLIND mode: "screenshot" returns the accessibility-tree inventory as
 * text, and every coordinate is a DIP screen pixel (identity transform). */
function blind(): boolean {
  return !activeModelAccepts("image");
}

/** Refuse to act on a denied foreground app (screenshots/reads are exempt,
 * and focus_window is how the agent LEAVES a denied app). */
async function deniedGuard(action: string): Promise<string | null> {
  if (
    action === "screenshot" ||
    action === "cursor_position" ||
    action === "list_elements" ||
    action === "focus_window" ||
    action === "launch_app"
  )
    return null;
  const denied = getComputerConfig().deniedApps.map((a) =>
    a.toLowerCase().replace(/\.exe$/, ""),
  );
  if (denied.length === 0) return null;
  const app = await foregroundApp();
  if (app && denied.includes(app)) {
    return `The foreground app "${app}" is on the Denied apps list — action refused. Ask the user to switch focus or remove it from Settings → Automation.`;
  }
  return null;
}

/** One element per line, centre coordinates ready to click. Coordinates are
 * mapped through `toImg` when the caller's space is not screen pixels. */
function formatElementLines(
  els: { n: string; t: string; x: number; y: number; w: number; h: number; k?: string }[],
  toImg?: (x: number, y: number) => [number, number],
): string {
  return els
    .slice(0, 180)
    .map((e, i) => {
      const cx = e.x + e.w / 2;
      const cy = e.y + e.h / 2;
      const [ix, iy] = toImg ? toImg(cx, cy) : [Math.round(cx), Math.round(cy)];
      const label = e.n ? `"${e.n}"` : "(unnamed)";
      // The Alt accelerator, when the app publishes one (Office ribbons do):
      // keystrokes beat coordinates on any DPI, so say so inline.
      const key = e.k ? ` — or press ${e.k.replace(/\s+/g, "")}` : "";
      return `${i + 1}. [${e.t}] ${label} — click at [${ix}, ${iy}]${key}`;
    })
    .join("\n");
}

/** The two lines that must come before any element list: an open modal
 * dialog (everything else bounces off with an error chime until it is
 * dealt with) and where the keyboard focus is. */
function formatScanExtras(scan: {
  dialogs?: string[];
  focused?: { n: string; t: string } | null;
}): string {
  let out = "";
  if (scan.dialogs && scan.dialogs.length > 0)
    out +=
      `!! MODAL DIALOG open: ${scan.dialogs.map((d) => `"${d}"`).join(", ")} — its controls are listed FIRST below. ` +
      `Deal with it before anything else; clicks outside it just bounce with an error sound.\n`;
  if (scan.focused)
    out += `Keyboard focus is on [${scan.focused.t}] ${scan.focused.n ? `"${scan.focused.n}"` : "(unnamed)"} — typing lands there.\n`;
  return out;
}

/** Blind-mode "screenshot": open windows + the foreground window's clickable
 * elements, coordinates in DIP screen pixels. */
async function describeScreen(note: string): Promise<ComputerOutput> {
  lastTransform = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
  const [wins, scan] = await Promise.all([
    listTopWindows(),
    listScreenElements(),
  ]);
  // Straight from the scan, which read it off the very window it walked —
  // never a separate probe racing these two (that reported "powershell").
  if (scan.app) lastSeenApp = scan.app;
  const winLines = wins
    .slice(0, 40)
    .map((w) => `- "${w.title}" (${w.app})`);
  let body: string;
  if (scan.ok && (scan.elements?.length ?? 0) > 0) {
    body =
      formatScanExtras(scan) +
      `Foreground window "${scan.title ?? ""}" — interactive elements (pass an element's [x, y] straight to a click action):\n` +
      formatElementLines(scan.elements ?? []);
  } else {
    // No accessibility tree — parse the pixels instead (OmniParser + WinOCR).
    const vis = await visionScreenElements();
    if (vis.ok && (vis.elements?.length ?? 0) > 0) {
      body =
        `Foreground window "${scan.title ?? "?"}" exposes no accessibility tree — the SCREEN was parsed visually instead ` +
        `(icon detector + OCR; boxes cover the WHOLE screen, not just one window). Elements:\n` +
        formatElementLines(vis.elements ?? []);
    } else {
      body =
        `Foreground window "${scan.title ?? "?"}" exposed no accessibility elements` +
        `${!scan.ok && scan.error ? ` (${scan.error})` : ""}, and the visual parse ` +
        `${vis.error ? `failed: ${vis.error}` : "found nothing"}. ` +
        `Try focus_window to reach another app, drive it with key/type, or ask the user.`;
    }
  }
  return {
    text:
      `${note}\n` +
      `Open windows (switch with focus_window):\n${winLines.join("\n")}\n\n` +
      body,
    isError: false,
  };
}

async function takeScreenshot(
  sessionId: string,
  note: string,
  region?: { x: number; y: number; width: number; height: number },
): Promise<ComputerOutput> {
  const shot = await captureScreen(region);
  // Our own helper processes must never become the expected target: a PS
  // probe that flashes to the foreground would otherwise lock typing out.
  const fg = await foregroundApp();
  if (fg && !HELPER_PROCESSES.has(fg)) lastSeenApp = fg;
  lastTransform = {
    scaleX: shot.scaleX,
    scaleY: shot.scaleY,
    offsetX: shot.offsetX,
    offsetY: shot.offsetY,
  };
  const name = `screen-${Date.now()}.png`;
  const path = saveArtifactBuffer(sessionId, name, shot.png);
  return {
    text:
      `${note}\n` +
      `Screen is ${shot.width}x${shot.height} px (give click coordinates in THIS space).\n` +
      `Crop region (screen coordinates): x=${shot.region.x}, y=${shot.region.y}, width=${shot.region.width}, height=${shot.region.height}.\n` +
      `Coordinate mapping: screenX = ${shot.region.x} + imageX * ${shot.scaleX}; screenY = ${shot.region.y} + imageY * ${shot.scaleY}.\n` +
      `[artifact] image/png ${name} :: ${artifactReference(path)}\n` +
      `Markdown: ![${name}](${artifactReference(path)})`,
    isError: false,
    imageBase64: shot.png.toString("base64"),
    imageMediaType: "image/png",
  };
}

export const ComputerTool = buildTool({
  name: "Computer",
  searchHint: "screenshot and control the desktop (mouse/keyboard)",
  maxResultSizeChars: 4_000,
  get inputSchema(): Schema {
    return schema();
  },
  userFacingName() {
    return "Computer";
  },
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    // Platform-true hints: the model must reach for cmd on a Mac and ctrl on
    // Windows, and "Start menu" means nothing in /Applications.
    const mac = process.platform === "darwin";
    const osName = mac ? "macOS" : "Windows";
    const modKey = mac ? "cmd+c" : "ctrl+c";
    const switchCombo = mac ? "cmd+Tab" : "alt+Tab";
    const appSource = mac ? "app name (as in /Applications)" : "Start-menu name";
    if (blind()) {
      return [
        `Control the user's desktop through the ${osName} accessibility tree —`,
        "no vision needed. FIRST call action='screenshot': instead of an image",
        "it returns TEXT — the list of open windows and every interactive",
        "element of the foreground window (buttons, fields, links…) with its",
        "name and [x, y] click point in screen pixels. Then act:",
        "- left_click / right_click / middle_click / double_click / mouse_move —",
        "  coordinate: [x, y] copied from an element's reported click point.",
        "- focus_window — text: part of a window title; brings that app to the",
        "  front. Use it to switch between the windows the screenshot listed.",
        `- launch_app — text: an app's ${appSource} (e.g. 'Excel',`,
        "  'Блокнот'); starts it directly — no menu clicking needed.",
        "- type — text: the text to type (Unicode ok).",
        "  Click the target field first.",
        `- key — text: a combo like '${modKey}', '${switchCombo}', 'Return', 'Escape'.`,
        "- scroll — coordinate + scroll_direction (up/down) + scroll_amount.",
        "After every click the tool re-reads the tree and returns the updated",
        "inventory — read it to verify the click did what you expected. A",
        "window with no accessibility tree (games, canvas apps) is parsed",
        "VISUALLY instead — an icon detector plus OCR — automatically; those",
        "labels come from OCR and can be imprecise, so double-check what a",
        "click did. Move deliberately; actions can't always be undone.",
      ].join("\n");
    }
    return [
      "Control the user's desktop visually. FIRST call action='screenshot' to",
      "see the screen; it returns an image — read it and give coordinates in",
      "that image's pixel space. Then act:",
      "- left_click / right_click / middle_click / double_click / mouse_move —",
      "  with coordinate: [x, y].",
      "- focus_window — text: part of a window title; brings that app to the front.",
      `- launch_app — text: an app's ${appSource}; starts it directly.`,
      "- type — text: the text to type (Unicode ok).",
      `- key — text: a combo like '${modKey}', '${switchCombo}', 'Return', 'Escape'.`,
      "- scroll — coordinate + scroll_direction (up/down) + scroll_amount.",
      "- cursor_position — where the pointer is.",
      "- screenshot may include region: {x, y, width, height}; the result reports the crop region.",
      "- list_elements — READ the foreground window's UI elements (buttons,",
      "  fields, links…) with their names and CLICKABLE coordinates from the",
      "  accessibility tree. PREFER this over guessing pixel positions from a",
      "  screenshot: take a screenshot, then list_elements, then click the",
      "  element's reported coordinate.",
      "Take a NEW screenshot after actions that change the screen to verify the",
      "result. Move deliberately; some actions can't be undone.",
    ].join("\n");
  },
  async description() {
    return "Screenshot and control the desktop (mouse/keyboard) — IAA Labs computer-use schema.";
  },
  async call(input: z.infer<Schema>, context: ToolUseContext) {
    const sessionId =
      (context as { sessionId?: string }).sessionId || "default";
    const { action, coordinate, text, scroll_direction, scroll_amount, region } = input;

    const denied = await deniedGuard(action);
    if (denied) return { data: { text: denied, isError: true } };

    // Glow frame + app-window dodge. Awaited so the FIRST screenshot of a run
    // is taken after the app has moved out of the way.
    await touchComputerOverlay();

    const needCoord = [
      "left_click",
      "right_click",
      "middle_click",
      "double_click",
      "mouse_move",
      "scroll",
    ].includes(action);
    let sx = 0;
    let sy = 0;
    if (needCoord) {
      if (!coordinate || coordinate.length < 2)
        return {
          data: { text: `Action ${action} needs coordinate: [x, y].`, isError: true },
        };
      const p = toScreenCoord(
        coordinate[0],
        coordinate[1],
        lastTransform.scaleX,
        lastTransform.scaleY,
        lastTransform.offsetX,
        lastTransform.offsetY,
      );
      // Never click our own parked window. During Computer Use it sits in the
      // top-right corner ON TOP of whatever is being driven; a click that
      // lands there types into the agent's own chat — a session spent minutes
      // entering spreadsheet data into its composer before diagnosing it.
      // Refused with an explanation, not silently: the model reroutes in one
      // turn when told what it hit.
      const own = getMainWindow()?.getBounds();
      if (
        own &&
        p.x >= own.x &&
        p.x <= own.x + own.width &&
        p.y >= own.y &&
        p.y <= own.y + own.height
      )
        return {
          data: {
            text:
              `[${p.x}, ${p.y}] lands on the Code Monet window itself (parked over the desktop during Computer Use) — refused, that would drive the agent's own chat. ` +
              `Aim at the target app's own coordinates, or focus_window it first.`,
            isError: true,
          },
        };
      // The tool's whole space is DIP (screenshots, UIA, vision alike); the
      // input layer is per-monitor-DPI-aware Win32 and wants PHYSICAL pixels.
      // Electron owns the display layout, so it does the conversion.
      //
      // Windows ONLY. dipToScreenPoint is a Win32-backed method that simply
      // does not exist on the other platforms — calling it on macOS threw
      // "screen.dipToScreenPoint is not a function" and killed every click,
      // drag and scroll the agent attempted. macOS needs no conversion at
      // all: AX rects, CGEvent and Electron all speak points already.
      if (process.platform === "win32") {
        const phys = screen.dipToScreenPoint({ x: p.x, y: p.y });
        sx = phys.x;
        sy = phys.y;
      }
    }

    try {
      switch (action) {
        case "screenshot": {
          if (blind())
            return {
              data: await describeScreen(
                region
                  ? "Screen read (accessibility tree; region crops don't apply here — the tree is always the whole foreground window)."
                  : "Screen read (accessibility tree).",
              ),
            };
          const regionObj = Array.isArray(region)
            ? { x: region[0], y: region[1], width: region[2], height: region[3] }
            : region;
          return { data: await takeScreenshot(sessionId, "Screenshot taken.", regionObj) };
        }
        case "focus_window": {
          if (!text)
            return {
              data: {
                text:
                  "focus_window needs text: part of a window title, or the " +
                  "application's name.",
                isError: true,
              },
            };
          const matched = await focusWindow(text);
          if (!matched)
            return {
              data: {
                // Name the real obstacle when there is one. Without Screen
                // Recording macOS reports every window title as empty, so the
                // old message sent the model to call screenshot and read a
                // list of blanks — it retried that until it gave up, with the
                // app it wanted sitting right there on screen.
                text:
                  (await titlesAreBlind())
                    ? `Nothing matched "${text}", and window TITLES are unavailable — macOS ` +
                      "withholds them until Screen Recording is granted to this app in " +
                      "System Settings → Privacy & Security. Matching by application name " +
                      "still works, so try the app's own name (e.g. 'Word', 'Chrome'), or " +
                      "launch_app to start it."
                    : `No open window or application matches "${text}". Call screenshot to ` +
                      "list the open windows, or launch_app to start the program.",
                isError: true,
              },
            };
          await new Promise((r) => setTimeout(r, 400));
          return {
            data: blind()
              ? await describeScreen(`Focused "${matched}".`)
              : await takeScreenshot(sessionId, `Focused "${matched}".`),
          };
        }
        case "launch_app": {
          if (!text)
            return {
              data: { text: "launch_app needs the app's Start-menu name in text.", isError: true },
            };
          // Snapshot the windows BEFORE launching, so the new one is
          // recognisable by not being in the set.
          const before = new Set(
            (await listTopWindows()).map((w) => `${w.app} ${w.title}`),
          );
          const started = await launchApp(text);
          if (!started)
            return {
              data: {
                text: `No installed app matches "${text}". Ask the user for the exact Start-menu name.`,
                isError: true,
              },
            };
          // Wait for the app's window, not a fixed pause: Excel splashes for
          // seconds, and scanning early reads whatever window was foreground
          // before — a real session got this app's own UI as the "result" of
          // launching Excel. Then focus it, because a slow starter comes up
          // BEHIND the window the user (or agent) was last in.
          let appeared: string | null = null;
          for (let i = 0; i < 12 && !appeared; i++) {
            await new Promise((r) => setTimeout(r, 700));
            const now = await listTopWindows();
            const fresh = now.find((w) => !before.has(`${w.app} ${w.title}`));
            if (fresh) appeared = fresh.title;
          }
          if (appeared) {
            await focusWindow(appeared);
            await new Promise((r) => setTimeout(r, 400));
          }
          const note = appeared
            ? `Launched "${started}" — window "${appeared}" is focused.`
            : `Launched "${started}", but no new window appeared within 8s — it may still be loading, or it reused an existing window. Check the window list.`;
          return {
            data: blind()
              ? await describeScreen(note)
              : await takeScreenshot(sessionId, note),
          };
        }
        case "list_elements": {
          // Blind mode has no screenshot space — coordinates ARE screen pixels.
          if (blind())
            lastTransform = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
          const scan = await listScreenElements();
          const els = scan.ok ? (scan.elements ?? []) : [];
          // Report centres in the LAST screenshot's image space — the same
          // space click coordinates are given in (inverse of lastTransform).
          const toImg = (sx: number, sy: number): [number, number] => [
            Math.round((sx - lastTransform.offsetX) / (lastTransform.scaleX || 1)),
            Math.round((sy - lastTransform.offsetY) / (lastTransform.scaleY || 1)),
          ];
          if (els.length === 0) {
            // No accessibility tree — parse the pixels (OmniParser + WinOCR).
            const vis = await visionScreenElements();
            if (vis.ok && (vis.elements?.length ?? 0) > 0)
              return {
                data: {
                  text:
                    `"${scan.title ?? "The foreground window"}" exposes no accessibility tree — the SCREEN was parsed visually ` +
                    `(icon detector + OCR; boxes cover the whole screen, not just one window). Coordinates are in the last ` +
                    `screenshot's pixel space — pass them directly to click actions:\n` +
                    formatElementLines(vis.elements ?? [], toImg),
                  isError: false,
                },
              };
            return {
              data: {
                text:
                  `No accessible elements found in "${scan.title ?? "the foreground window"}"` +
                  `${!scan.ok && scan.error ? ` (${scan.error})` : ""}, and the visual parse ` +
                  `${vis.error ? `failed: ${vis.error}` : "found nothing"}. Use screenshot + visual coordinates.`,
                isError: false,
              },
            };
          }
          return {
            data: {
              text:
                formatScanExtras(scan) +
                `UI elements of "${scan.title ?? ""}" (coordinates are in the last screenshot's pixel space — pass them directly to click actions):\n` +
                formatElementLines(els, toImg),
              isError: false,
            },
          };
        }
        case "cursor_position": {
          const p = await cursorPosition();
          // Physical from the DPI-aware input layer → the tool's DIP space.
          const dip = screen.screenToDipPoint({ x: p.x, y: p.y });
          return { data: { text: `Cursor at ${dip.x}, ${dip.y} (screen px).`, isError: false } };
        }
        case "mouse_move":
          await moveMouse(sx, sy);
          return { data: { text: `Moved to ${coordinate?.join(", ")}.`, isError: false } };
        case "left_click":
        case "right_click":
        case "middle_click":
        case "double_click": {
          const button =
            action === "right_click"
              ? "right"
              : action === "middle_click"
                ? "middle"
                : "left";
          await click(sx, sy, button, action === "double_click");
          // Auto-verify so the model sees the result immediately: a fresh
          // screenshot, or in blind mode a fresh accessibility inventory.
          await new Promise((r) => setTimeout(r, 500));
          return {
            data: blind()
              ? await describeScreen(`${action} at ${coordinate?.join(", ")}.`)
              : await takeScreenshot(
                  sessionId,
                  `${action} at ${coordinate?.join(", ")}.`,
                ),
          };
        }
        case "type": {
          if (!text) return { data: { text: "type needs text.", isError: true } };
          // Refuse to type into a window the model has not seen. The check
          // runs inside the input script itself, so there is no gap between
          // checking and typing — a target that closed mid-run used to keep
          // collecting "Typed N chars" successes while the keys sprayed at
          // whatever window came next.
          const r = await typeText(text, lastSeenApp ?? undefined);
          if (!r.ok)
            return {
              data: {
                text: `Not typed: the foreground app changed since you last looked — it is now "${r.actual}", not "${lastSeenApp}". Call screenshot to see what happened.`,
                isError: true,
              },
            };
          return { data: { text: `Typed ${text.length} chars.`, isError: false } };
        }
        case "key": {
          if (!text) return { data: { text: "key needs a combo in text.", isError: true } };
          const r = await pressKey(text, lastSeenApp ?? undefined);
          if (!r.ok)
            return {
              data: {
                text: `Not pressed: the foreground app changed since you last looked — it is now "${r.actual}", not "${lastSeenApp}". Call screenshot to see what happened.`,
                isError: true,
              },
            };
          return { data: { text: `Pressed ${text}.`, isError: false } };
        }
        case "scroll":
          await scroll(sx, sy, scroll_direction ?? "down", scroll_amount ?? 3);
          return { data: { text: `Scrolled ${scroll_direction ?? "down"}.`, isError: false } };
        default:
          return { data: { text: `Unknown action: ${action}`, isError: true } };
      }
    } catch (err) {
      return {
        data: {
          text: `Computer action failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        },
      };
    }
  },
  mapToolResultToToolResultBlockParam(
    content: ComputerOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      type: "tool_result",
      tool_use_id: toolUseID,
      content: content.text,
      is_error: content.isError || undefined,
    };
  },
  renderToolUseMessage() {
    return null;
  },
});
