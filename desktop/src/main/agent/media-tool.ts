/**
 * ReadMediaFile — let the agent LOOK at an image or video it did not receive.
 *
 * Until now pictures only entered a conversation one way: the user attached
 * one. The agent could write a chart, save a screenshot, or find a mockup in
 * the repo and still be unable to see any of it — it could describe the file's
 * bytes and nothing more. Kimi Code makes this a first-class tool, and the
 * gap it closes is real: "render this and check it looks right" was not
 * something the agent could do.
 *
 * Pixel work goes through Electron's nativeImage — resize, crop and re-encode
 * with no new dependency. The arithmetic lives in media-fit.ts.
 *
 * Two rules worth stating, both borrowed:
 *
 *  - Every delivery carries a `<system>` note with the ORIGINAL dimensions and
 *    what was done to the image. A coordinate read off a downsampled copy is
 *    wrong by exactly the scale factor, and stating the original every time is
 *    the only defence.
 *  - When the file cannot be made to fit, REFUSE. Sending it anyway produces a
 *    provider error the model cannot interpret; "make a smaller copy and read
 *    that" is something it can act on.
 */

import { readFileSync, statSync } from "fs";
import { extname, isAbsolute } from "path";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "../engine/Tool.js";
import { lazySchema } from "./lazy-schema.js";
import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { tunablePrompt } from "../prompts/index.js";
import {
  describeDelivery,
  MAX_MEDIA_BYTES,
  planFit,
  READ_BYTE_BUDGET,
  type Size,
} from "./media-fit.js";
import { resolveSandboxPath } from "../sandbox/files.js";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
};

function mediaKind(path: string): {
  kind: "image" | "video";
  mediaType: string;
} | null {
  const ext = extname(path).toLowerCase();
  if (IMAGE_TYPES[ext]) return { kind: "image", mediaType: IMAGE_TYPES[ext] };
  if (VIDEO_TYPES[ext]) return { kind: "video", mediaType: VIDEO_TYPES[ext] };
  return null;
}

const schema = lazySchema(() =>
  z.strictObject({
    path: z
      .string()
      .describe(
        "Image or video to look at. In Home this is a path inside this chat's sandbox; in Code an absolute path or one relative to the workspace.",
      ),
    region: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .optional()
      .describe(
        "Crop, in the ORIGINAL image's pixel coordinates. Delivered at native resolution — use this when a downsampled read lost the detail you need.",
      ),
    full_resolution: z
      .boolean()
      .optional()
      .describe(
        "Send the whole image without downsampling. Only works when the file already fits the per-image byte budget; otherwise the call is refused.",
      ),
  }),
);
type Schema = ReturnType<typeof schema>;

interface Output {
  text: string;
  isError: boolean;
  imageBase64?: string;
  imageMediaType?: string;
}

/**
 * Text only. The picture itself rides on `imageBase64` / `imageMediaType` in
 * the result DATA, which executeVendorTool lifts into VendorToolResult.image
 * and the agent loop turns into a real image block — the same path Computer
 * Use screenshots take. Building an image block here as well would send it
 * twice.
 */
const mapResult = (
  data: Output,
  toolUseID: string,
): ToolResultBlockParam => ({
  type: "tool_result",
  tool_use_id: toolUseID,
  content: data.text,
  is_error: data.isError || undefined,
});

const err = (text: string): { data: Output } => ({
  data: { text, isError: true },
});

/**
 * Squeeze an image under the byte budget, or report that it cannot be done.
 *
 * Quality alone is not enough, and assuming it was is a bug this had until it
 * was run: a 2000x1333 screenshot of dense UI came out at 275 KB even at JPEG
 * quality 40, so the tool would have refused an entirely ordinary image. Edge
 * length has to come down too.
 *
 * PNG is tried first and kept when it fits — it holds small text and UI edges
 * that JPEG smears, which is most of what an agent looks at. JPEG is not
 * automatically smaller: on the same fixture, quality 85 was LARGER than the
 * PNG. So every attempt is measured and the smallest is kept, rather than
 * trusting an ordering.
 */
function encodeWithinBudget(
  image: Electron.NativeImage,
): { buffer: Buffer; mediaType: string; size: Size } | null {
  const png = image.toPNG();
  if (png.byteLength <= READ_BYTE_BUDGET)
    return { buffer: png, mediaType: "image/png", size: image.getSize() };

  const full = image.getSize();
  for (const factor of [1, 0.75, 0.5, 0.35, 0.25]) {
    const scaled =
      factor === 1
        ? image
        : image.resize({
            width: Math.max(1, Math.round(full.width * factor)),
            height: Math.max(1, Math.round(full.height * factor)),
            quality: "good",
          });
    for (const quality of [85, 65, 45]) {
      const buf = scaled.toJPEG(quality);
      if (buf.byteLength <= READ_BYTE_BUDGET)
        return { buffer: buf, mediaType: "image/jpeg", size: scaled.getSize() };
    }
  }
  return null;
}

/** Resolve the argument against whichever file space this run has. */
function resolvePath(
  raw: string,
  space: string | undefined,
  sessionId: string,
): { path: string } | { error: string } {
  if (space === "home") {
    if (isAbsolute(raw))
      return {
        error:
          "Home has no access to the machine's filesystem. Give a path inside this chat's sandbox (see Glob).",
      };
    const abs = resolveSandboxPath(sessionId, raw);
    if (!abs)
      return { error: `${raw} is outside this chat's sandbox.` };
    return { path: abs };
  }
  return { path: raw };
}

export const ReadMediaFileTool = buildTool({
  name: "ReadMediaFile",
  searchHint: "view image screenshot picture video look",
  // The text half is only the <system> note; the picture travels separately.
  maxResultSizeChars: 4_000,
  get inputSchema(): Schema {
    return schema();
  },
  userFacingName() {
    return "ReadMediaFile";
  },
  isEnabled() {
    return true;
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  async prompt() {
    return tunablePrompt(
      "tool-read-media-file",
      [
        "LOOK at an image or video file — the pixels come back to you, not just",
        "a description. Use it after producing a chart, a screenshot or a",
        "rendered page to check the result, and to read a mockup or diagram the",
        "user pointed at.",
        "",
        "Each result carries a <system> note with the ORIGINAL pixel size and",
        "what was done to the image. Large images are downsampled by default, so",
        "compute any coordinate from the ORIGINAL size in that note — never by",
        "measuring the copy you were shown.",
        "",
        "When downsampling lost the detail you need (small text, dense UI), call",
        "again with `region` — coordinates in the ORIGINAL image's pixel space —",
        "to get that part at native resolution. Re-reading the same file with no",
        "arguments just returns the same downsampled picture.",
        "",
        "If a file cannot be fitted to the limits the call is refused rather than",
        "sent. Follow the error: make a smaller copy, then read that. Do not",
        "retry the unchanged file.",
      ].join("\n"),
    );
  },
  async description() {
    return "Read an image or video file so the model can see it.";
  },
  async call(input: z.infer<Schema>, context: ToolUseContext) {
    const sessionId =
      (context as { sessionId?: string }).sessionId || "default";
    const space = (context as { space?: string }).space;

    const resolved = resolvePath(input.path, space, sessionId);
    if ("error" in resolved) return err(resolved.error);
    const path = resolved.path;

    const kind = mediaKind(path);
    if (!kind)
      return err(
        `${input.path} is not an image or video. Use Read for text files.`,
      );

    let bytes: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) return err(`${input.path} is not a file.`);
      bytes = st.size;
    } catch {
      return err(`${input.path} does not exist or cannot be opened.`);
    }

    if (bytes > MAX_MEDIA_BYTES)
      return err(
        `${input.path} is ${Math.round(bytes / 1024 / 1024)} MB, over the ` +
          `${MAX_MEDIA_BYTES / 1024 / 1024} MB limit. Make a smaller copy and read that.`,
      );

    // Modality gate. Checked here rather than at tool-advertisement time
    // because the user can switch models mid-conversation, and a tool that
    // was legal when the turn started may not be now.
    const { activeModelAccepts } = await import("./vendor-tools.js");
    if (!activeModelAccepts(kind.kind))
      return err(
        `The active model does not accept ${kind.kind} input. Switch to a ` +
          `multimodal model, or work from the file's metadata instead.`,
      );

    if (kind.kind === "video") {
      // No transcoding: a video is sent whole or not at all.
      const data = readFileSync(path);
      return {
        data: {
          text: `<system>${input.path} — ${kind.mediaType}, ${Math.round(bytes / 1024)} KB. Delivered untouched.</system>`,
          isError: false,
          imageBase64: data.toString("base64"),
          imageMediaType: kind.mediaType,
        },
      };
    }

    const { nativeImage } = await import("electron");
    let img = nativeImage.createFromPath(path);
    if (img.isEmpty())
      return err(
        `${input.path} could not be decoded as an image — it may be corrupt or ` +
          `not really ${kind.mediaType}.`,
      );

    const original: Size = img.getSize();
    const plan = planFit({
      bytes,
      size: original,
      region: input.region,
      fullResolution: input.full_resolution,
    });

    if (plan.kind === "refuse")
      return err(
        describeDelivery({
          path: input.path,
          mediaType: kind.mediaType,
          bytes,
          original,
          plan,
        }),
      );

    let mediaType = kind.mediaType;
    let delivered: Size = original;

    if (plan.kind === "crop") {
      img = img.crop(plan.region);
      delivered = img.getSize();
    } else if (plan.kind === "downsample") {
      if (plan.scale < 1) {
        img = img.resize({ ...plan.to, quality: "good" });
        delivered = img.getSize();
      }
    }

    const encoded = encodeWithinBudget(img);
    if (!encoded)
      return err(
        `${input.path} could not be compressed under the ` +
          `${READ_BYTE_BUDGET / 1024} KB per-image budget even at reduced size ` +
          `and quality. Read a smaller \`region\` of it, or make a smaller copy ` +
          `and read that.`,
      );
    const out = encoded.buffer;
    mediaType = encoded.mediaType;
    delivered = encoded.size;

    return {
      data: {
        text: describeDelivery({
          path: input.path,
          mediaType,
          bytes,
          original,
          plan,
          delivered,
        }),
        isError: false,
        imageBase64: out.toString("base64"),
        imageMediaType: mediaType,
      },
    };
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});
