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
  moveMouse,
  pressKey,
  scroll,
  typeText,
} from "../computer/input.js";
import { activeModelAccepts } from "./model-modalities.js";
import { getComputerConfig } from "../computer/config.js";
import { touchComputerOverlay } from "../computer/overlay.js";
import { visionScreenElements } from "../computer/vision.js";
import { artifactReference, saveArtifactBuffer } from "../ipc/artifacts.js";

// The transform from the most recent screenshot to virtual desktop pixels.
let lastTransform = {
  scaleX: 1,
  scaleY: 1,
  offsetX: 0,
  offsetY: 0,
};

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
        "Text to type (action=type), a key combo like 'ctrl+c', 'Return' (action=key), or part of a window title (action=focus_window).",
      ),
    scroll_direction: z.enum(["up", "down"]).optional(),
    scroll_amount: z.number().optional().describe("Wheel clicks (default 3)."),
    region: z
      .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
      .optional()
      .describe("Optional screen crop in full-screen coordinates for screenshot."),
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
    action === "focus_window"
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
  els: { n: string; t: string; x: number; y: number; w: number; h: number }[],
  toImg?: (x: number, y: number) => [number, number],
): string {
  return els
    .slice(0, 120)
    .map((e, i) => {
      const cx = e.x + e.w / 2;
      const cy = e.y + e.h / 2;
      const [ix, iy] = toImg ? toImg(cx, cy) : [Math.round(cx), Math.round(cy)];
      const label = e.n ? `"${e.n}"` : "(unnamed)";
      return `${i + 1}. [${e.t}] ${label} — click at [${ix}, ${iy}]`;
    })
    .join("\n");
}

/** Blind-mode "screenshot": open windows + the foreground window's clickable
 * elements, coordinates in DIP screen pixels. */
async function describeScreen(note: string): Promise<ComputerOutput> {
  lastTransform = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
  const [wins, scan] = await Promise.all([
    listTopWindows(),
    listScreenElements(),
  ]);
  const winLines = wins
    .slice(0, 40)
    .map((w) => `- "${w.title}" (${w.app})`);
  let body: string;
  if (scan.ok && (scan.elements?.length ?? 0) > 0) {
    body =
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
    if (blind()) {
      return [
        "Control the user's desktop through the Windows accessibility tree —",
        "no vision needed. FIRST call action='screenshot': instead of an image",
        "it returns TEXT — the list of open windows and every interactive",
        "element of the foreground window (buttons, fields, links…) with its",
        "name and [x, y] click point in screen pixels. Then act:",
        "- left_click / right_click / middle_click / double_click / mouse_move —",
        "  coordinate: [x, y] copied from an element's reported click point.",
        "- focus_window — text: part of a window title; brings that app to the",
        "  front. Use it to switch between the windows the screenshot listed.",
        "- type — text: the text to type (pastes via clipboard; Unicode ok).",
        "  Click the target field first.",
        "- key — text: a combo like 'ctrl+c', 'alt+Tab', 'Return', 'Escape'.",
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
      "- type — text: the text to type (pastes via clipboard; Unicode ok).",
      "- key — text: a combo like 'ctrl+c', 'alt+Tab', 'Return', 'Escape'.",
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
      sx = p.x;
      sy = p.y;
    }

    try {
      switch (action) {
        case "screenshot":
          if (blind())
            return {
              data: await describeScreen("Screen read (accessibility tree)."),
            };
          return { data: await takeScreenshot(sessionId, "Screenshot taken.", region) };
        case "focus_window": {
          if (!text)
            return {
              data: { text: "focus_window needs part of a window title in text.", isError: true },
            };
          const matched = await focusWindow(text);
          if (!matched)
            return {
              data: {
                text: `No open window title contains "${text}". Call screenshot to list the open windows.`,
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
                `UI elements of "${scan.title ?? ""}" (coordinates are in the last screenshot's pixel space — pass them directly to click actions):\n` +
                formatElementLines(els, toImg),
              isError: false,
            },
          };
        }
        case "cursor_position": {
          const p = await cursorPosition();
          return { data: { text: `Cursor at ${p.x}, ${p.y} (screen px).`, isError: false } };
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
        case "type":
          if (!text) return { data: { text: "type needs text.", isError: true } };
          await typeText(text);
          return { data: { text: `Typed ${text.length} chars.`, isError: false } };
        case "key":
          if (!text) return { data: { text: "key needs a combo in text.", isError: true } };
          await pressKey(text);
          return { data: { text: `Pressed ${text}.`, isError: false } };
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
