/**
 * SandboxImage — the model asks for a toolchain; the user decides.
 *
 * A chat cannot install gcc for itself. Its container runs with --rm, so
 * `apt-get install` is undone the moment the command returns — the model tries
 * it, sees "Successfully installed", and then watches the next call fail with
 * "command not found". The durable place is the shared image.
 *
 * That is exactly why this is not a tool that just does it. The image is shared
 * by every chat on the machine and a build is minutes and hundreds of megabytes,
 * so the model's part is to NAME what it needs; the permission prompt puts the
 * decision where it belongs. Python packages do not come through here at all —
 * `pip install` into the shared layer is instant and per-package (see
 * PIP_ENV_ARGS), and telling the two apart is most of this tool's prompt.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "../engine/Tool.js";
import { lazySchema } from "./lazy-schema.js";
import {
  IMAGE_PRESETS,
  describeExtras,
  getImageExtras,
  setImageExtras,
} from "../sandbox/image-extras.js";
import {
  ensureSandboxImage,
  resetImageCache,
} from "../sandbox/podman-engine.js";
import { getSessionEngine } from "../sandbox/config.js";
import { tunablePrompt } from "../prompts/index.js";

const inputSchema = lazySchema(() =>
  z.strictObject({
    toolchain: z
      .string()
      .optional()
      .describe(
        `One of: ${IMAGE_PRESETS.map((p) => p.id).join(", ")}. Omit to see what is already installed.`,
      ),
    lines: z
      .string()
      .optional()
      .describe(
        "Containerfile lines, for something no preset covers (e.g. 'RUN apt-get update && apt-get install -y --no-install-recommends sqlite3'). No FROM line.",
      ),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

interface Output {
  text: string;
  isError: boolean;
}

function currently(): string {
  const now = describeExtras();
  return now.length
    ? `Already in the image: ${now.join(", ")}.`
    : "Nothing has been added to the image yet.";
}

/** What can be added. Built-ins are listed separately — see alreadyThere. */
function catalogue(): string {
  return IMAGE_PRESETS.filter((p) => !p.builtin)
    .map((p) => `- ${p.id}: ${p.provides} (${p.size})`)
    .join("\n");
}

/**
 * What the image already has.
 *
 * Worth the tokens: without it the model reads a list of toolchains it can ask
 * for, infers that everything else is absent, and asks for pandas — which has
 * been in the base image all along.
 */
function alreadyThere(): string {
  return IMAGE_PRESETS.filter((p) => p.builtin)
    .map((p) => `- ${p.provides}`)
    .join("\n");
}

export const SandboxImageTool = buildTool({
  name: "SandboxImage",
  searchHint: "add a compiler or toolchain to the sandbox image",
  maxResultSizeChars: 20_000,
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  userFacingName() {
    return "Sandbox Image";
  },
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return tunablePrompt(
      "tool-sandbox-image",
      [
        "Add a COMPILER OR TOOLCHAIN to the sandbox image — gcc, Rust, Go, a JDK,",
        "ffmpeg. The sandbox container is discarded after every call, so",
        "`apt-get install` from RunCommand does nothing that lasts: this is the",
        "only way such a tool becomes available.",
        "",
        "NOT for Python packages. `pip install <name>` through RunCommand is",
        "instant, lands in a layer shared by every chat, and needs no permission.",
        "Reach for this only when the missing thing is not a Python package.",
        "",
        "The image is shared by every chat and building takes minutes, so the",
        "user is asked before anything is built, and may say no — in which case",
        "solve the problem another way rather than asking again. Call it with no",
        "arguments to see what is already there.",
        "",
        "ALREADY IN THE IMAGE — use these directly, never ask for them:",
        alreadyThere(),
        "",
        "Available to add:",
        catalogue(),
      ].join("\n"),
    );
  },
  async description() {
    return "Add a compiler or toolchain (gcc, Rust, Go, JDK, ffmpeg) to the shared sandbox image, with the user's permission.";
  },
  async call(
    { toolchain, lines }: z.infer<InputSchema>,
    context: ToolUseContext,
  ) {
    const sessionId = (context as { sessionId?: string }).sessionId || "default";
    if (!toolchain && !lines)
      return {
        data: {
          text:
            `Already in the image:\n${alreadyThere()}\n\n${currently()}\n\n` +
            `Available to add:\n${catalogue()}`,
          isError: false,
        },
      };
    // Asking for something the base already has: say so and stop. Building a
    // layer for it would be minutes spent installing nothing.
    const builtin = IMAGE_PRESETS.find((p) => p.id === toolchain && p.builtin);
    if (builtin)
      return {
        data: {
          text: `${builtin.label} is already in the sandbox image — ${builtin.provides}. Use it directly.`,
          isError: false,
        },
      };
    if (toolchain && !IMAGE_PRESETS.some((p) => p.id === toolchain))
      return {
        data: {
          text: `No toolchain called "${toolchain}". Available:\n${catalogue()}\n\nFor anything else, pass Containerfile lines instead.`,
          isError: true,
        },
      };
    // Podman is the only engine with an image. Saying so plainly beats building
    // nothing and reporting success.
    if (getSessionEngine(sessionId) !== "docker")
      return {
        data: {
          text: "This chat is not running the Podman sandbox, which is the only engine with an image to extend. The user can switch engines in Settings → Sandbox.",
          isError: true,
        },
      };

    const before = getImageExtras();
    const presets =
      toolchain && !before.presets.includes(toolchain)
        ? [...before.presets, toolchain]
        : before.presets;
    const extra = lines?.trim()
      ? `${before.extra.trim()}\n${lines.trim()}`.trim()
      : before.extra;
    setImageExtras({ presets, extra });
    resetImageCache();

    const onProgress = (context as { onProgress?: (t: string) => void })
      .onProgress;
    onProgress?.("Building the sandbox image — this takes a few minutes…");
    const r = await ensureSandboxImage();
    if (!r.ok) {
      // Put the recipe back: a set that cannot be built should not be left in
      // the user's settings for every future run to retry.
      setImageExtras(before);
      resetImageCache();
      return {
        data: { text: `The image could not be built: ${r.error}`, isError: true },
      };
    }
    // ensureSandboxImage reports a failed LAYER through its log while staying
    // ok — the base is fine, the addition is not. That distinction has to reach
    // the model, or it will carry on as though gcc were there.
    const failed = /failed to build/i.test(r.log);
    if (failed) {
      setImageExtras(before);
      resetImageCache();
      return {
        data: {
          text: `That did not build, and nothing changed:\n${r.log.trim()}`,
          isError: true,
        },
      };
    }
    const added = toolchain
      ? (IMAGE_PRESETS.find((p) => p.id === toolchain)?.provides ?? toolchain)
      : "the requested lines";
    return {
      data: {
        text:
          `Installed into the sandbox image: ${added}. It is available in this ` +
          `chat and every other one, from the next RunCommand or RunPython on — ` +
          `no need to install it again.`,
        isError: false,
      },
    };
  },
  mapToolResultToToolResultBlockParam(
    content: Output,
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
