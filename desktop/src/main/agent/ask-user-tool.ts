/**
 * AskUserQuestion tool (desktop-native).
 *
 * Lets the model pause mid-task and ask the user a small number of structured,
 * multiple-choice questions when a decision is genuinely the user's to make.
 * The answer round-trips through the renderer (AskUserDialog) via the askUser
 * callback threaded onto the tool context, then comes back as the tool result.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import { tunablePrompt } from "../prompts/index.js";
import type {
  AskUserFn,
  AskUserQuestionSpec,
} from "../ipc/ask-user.js";

interface TextOutput {
  text: string;
  isError: boolean;
}

const mapResult = (
  content: TextOutput,
  toolUseID: string,
): ToolResultBlockParam => ({
  type: "tool_result",
  tool_use_id: toolUseID,
  content: content.text,
  is_error: content.isError || undefined,
});

const inputSchema = lazySchema(() =>
  z.strictObject({
    questions: z
      .array(
        z.object({
          question: z.string().describe("The full question to ask the user."),
          header: z
            .string()
            .describe("Very short label shown as a chip (e.g. \"Approach\")."),
          multiSelect: z
            .boolean()
            .default(false)
            .describe("Allow selecting more than one option."),
          options: z
            .array(
              z.object({
                label: z.string().describe("The choice text the user sees."),
                description: z
                  .string()
                  .optional()
                  .describe("Optional explanation of the choice."),
              }),
            )
            .min(2)
            .max(4)
            .describe("2–4 distinct choices."),
        }),
      )
      .min(1)
      .max(4)
      .describe("1–4 questions to ask at once."),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

export const AskUserQuestionTool = buildTool({
  name: "AskUserQuestion",
  searchHint: "ask the user a structured multiple-choice question",
  maxResultSizeChars: 8_000,
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  userFacingName() {
    return "Ask User";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return tunablePrompt(
      "tool-ask-user",
      [
        "Ask the user 1–4 structured multiple-choice questions when a decision is",
        "genuinely theirs to make and you cannot resolve it from the request, the",
        "code, or sensible defaults. Each question has a short `header`, the",
        "`question` text, and 2–4 `options` (with optional descriptions); set",
        "`multiSelect` when several answers may combine. The user can always type a",
        "custom answer. Don't use this for decisions with an obvious default —",
        "pick it and proceed instead.",
      ].join(" "),
    );
  },
  async description() {
    return "Ask the user a small number of structured multiple-choice questions.";
  },
  async call(
    { questions }: z.infer<InputSchema>,
    context: ToolUseContext,
  ) {
    const ask = (context as { askUser?: AskUserFn }).askUser;
    if (!ask) {
      return {
        data: {
          text: "AskUserQuestion isn't available in this environment. Proceed with a sensible default and explain your choice.",
          isError: true,
        },
      };
    }
    const result = await ask(questions as AskUserQuestionSpec[]);
    if (result.cancelled) {
      return {
        data: {
          text: "The user dismissed the questions without answering. Proceed with a sensible default and say what you assumed.",
          isError: false,
        },
      };
    }
    const text = result.answers
      .map((a) => `${a.header}: ${a.selected.join(", ") || "(no answer)"}`)
      .join("\n");
    return { data: { text: text || "(no answers)", isError: false } };
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});
