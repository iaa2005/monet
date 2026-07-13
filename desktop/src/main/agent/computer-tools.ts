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
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import { captureScreen, toScreenCoord } from "../computer/screen.js";
import {
  click,
  cursorPosition,
  foregroundApp,
  moveMouse,
  pressKey,
  scroll,
  typeText,
} from "../computer/input.js";
import { getComputerConfig } from "../computer/config.js";
import { artifactReference, saveArtifactBuffer } from "../ipc/artifacts.js";

// The scale from the most recent screenshot (model image px → DIP screen px).
let lastScale = 1;

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
      .describe("Text to type (action=type) or a key combo like 'ctrl+c', 'Return' (action=key)."),
    scroll_direction: z.enum(["up", "down"]).optional(),
    scroll_amount: z.number().optional().describe("Wheel clicks (default 3)."),
  }),
);
type Schema = ReturnType<typeof schema>;

/** Refuse to act on a denied foreground app (screenshots/reads are exempt). */
async function deniedGuard(action: string): Promise<string | null> {
  if (action === "screenshot" || action === "cursor_position") return null;
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

async function takeScreenshot(
  sessionId: string,
  note: string,
): Promise<ComputerOutput> {
  const shot = await captureScreen();
  lastScale = shot.scale;
  const name = `screen-${Date.now()}.png`;
  const path = saveArtifactBuffer(sessionId, name, shot.png);
  return {
    text:
      `${note}\n` +
      `Screen is ${shot.width}x${shot.height} px (give click coordinates in THIS space).\n` +
      `[artifact] image/png ${name} :: ${artifactReference(path)}\n` +
      `Markdown: ![${name}](${artifactReference(path)})`,
    isError: false,
    imageBase64: shot.png.toString("base64"),
    imageMediaType: "image/png",
  };
}

export const ComputerTool = buildTool({
  name: "computer",
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
    return [
      "Control the user's desktop visually. FIRST call action='screenshot' to",
      "see the screen; it returns an image — read it and give coordinates in",
      "that image's pixel space. Then act:",
      "- left_click / right_click / middle_click / double_click / mouse_move —",
      "  with coordinate: [x, y].",
      "- type — text: the text to type (pastes via clipboard; Unicode ok).",
      "- key — text: a combo like 'ctrl+c', 'alt+Tab', 'Return', 'Escape'.",
      "- scroll — coordinate + scroll_direction (up/down) + scroll_amount.",
      "- cursor_position — where the pointer is.",
      "Take a NEW screenshot after actions that change the screen to verify the",
      "result. Move deliberately; some actions can't be undone.",
    ].join("\n");
  },
  async description() {
    return "Screenshot and control the desktop (mouse/keyboard) — Anthropic computer-use schema.";
  },
  async call(input: z.infer<Schema>, context: ToolUseContext) {
    const sessionId =
      (context as { sessionId?: string }).sessionId || "default";
    const { action, coordinate, text, scroll_direction, scroll_amount } = input;

    const denied = await deniedGuard(action);
    if (denied) return { data: { text: denied, isError: true } };

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
      const p = toScreenCoord(coordinate[0], coordinate[1], lastScale);
      sx = p.x;
      sy = p.y;
    }

    try {
      switch (action) {
        case "screenshot":
          return { data: await takeScreenshot(sessionId, "Screenshot taken.") };
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
          // Auto-screenshot so the model sees the result immediately.
          await new Promise((r) => setTimeout(r, 500));
          return {
            data: await takeScreenshot(
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
