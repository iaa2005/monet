/**
 * Sleep — wait for a duration, interruptibly.
 *
 * The bundle ships the vendor's name, description and prompt for this tool but
 * no implementation (SleepTool/ only contains prompt.ts), so the behaviour is
 * written here against the vendor's own constants — the model sees exactly the
 * contract upstream describes.
 *
 * Interruptible is the whole point: a sleep that ignores the abort signal
 * would keep the turn alive after the user pressed stop.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "./lazy-schema.js";
import {
  SLEEP_TOOL_NAME,
  SLEEP_TOOL_PROMPT,
  DESCRIPTION,
} from "@vendor/tools/SleepTool/prompt.js";
import { tunablePrompt } from "../prompts/index.js";

interface Output {
  text: string;
  isError: boolean;
}

/** A model that asks for an hour has misunderstood; cap it. */
const MAX_SECONDS = 300;

const inputSchema = lazySchema(() =>
  z.strictObject({
    seconds: z
      .number()
      .min(0)
      .max(MAX_SECONDS)
      .describe(
        `How long to wait, in seconds (max ${MAX_SECONDS}). The user can interrupt at any time.`,
      ),
    reason: z
      .string()
      .optional()
      .describe("Why you are waiting — shown to the user."),
  }),
);

type InputSchema = ReturnType<typeof inputSchema>;

export const SleepTool = buildTool({
  name: SLEEP_TOOL_NAME,
  searchHint: "wait for a duration before continuing",
  maxResultSizeChars: 500,
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  userFacingName() {
    return "Sleep";
  },
  isReadOnly() {
    return true; // touches nothing
  },
  isConcurrencySafe() {
    return true;
  },
  async prompt() {
    return tunablePrompt("tool-sleep", SLEEP_TOOL_PROMPT);
  },
  async description() {
    return DESCRIPTION;
  },
  async call(input: z.infer<InputSchema>, context: ToolUseContext) {
    const seconds = Math.min(Math.max(input.seconds, 0), MAX_SECONDS);
    const signal = context.abortController?.signal;
    if (signal?.aborted)
      return { data: { text: "Sleep skipped: already interrupted.", isError: false } };

    const interrupted = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(false);
      }, seconds * 1000);
      function onAbort(): void {
        clearTimeout(timer);
        resolve(true);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });

    return {
      data: {
        text: interrupted
          ? `Sleep interrupted before the full ${seconds}s elapsed.`
          : `Waited ${seconds}s.`,
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
