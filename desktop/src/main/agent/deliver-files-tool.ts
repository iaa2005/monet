/**
 * DeliverFiles — the model hands finished files to the user.
 *
 * Everything a sandbox run writes is a WORKING file: reachable, versioned,
 * invisible. A LaTeX job writes csv → png → tex → pdf, and the user asked for
 * one pdf — which of those fifteen files is the result is a judgement only the
 * model can make, so delivery is an explicit act, not a side effect of
 * writing. This tool makes that act: it snapshots the named files out of the
 * chat's sandbox into the artifacts store and emits the `[artifact]` marker
 * lines the chat renders as file cards.
 *
 * The snapshot matters: the delivered copy is frozen at the moment of
 * delivery, so a later run overwriting report.pdf in the sandbox cannot
 * silently rewrite what the user was handed.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { readFileSync, statSync } from "fs";
import { buildTool, type ToolUseContext } from "../engine/Tool.js";
import { lazySchema } from "./lazy-schema.js";
import { resolveSandboxPath } from "../sandbox/files.js";
import { mediaTypeOf } from "../sandbox/index.js";
import { artifactReference, saveArtifactBuffer } from "../ipc/artifacts.js";
import { tunablePrompt } from "../prompts/index.js";

/** A delivery is chat material, not a transfer channel. */
const MAX_DELIVER_BYTES = 100 * 1024 * 1024;

const inputSchema = lazySchema(() =>
  z.strictObject({
    files: z
      .array(z.string())
      .min(1)
      .max(20)
      .describe(
        "Sandbox-relative paths of the FINISHED files to hand to the user, as shown by Glob or the [file] lines (e.g. ['report.pdf'] or ['charts/q4.png']).",
      ),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

interface TextOutput {
  text: string;
  isError: boolean;
}

export const DeliverFilesTool = buildTool({
  name: "DeliverFiles",
  searchHint: "hand finished files to the user",
  maxResultSizeChars: 8_000,
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  userFacingName() {
    return "Deliver files";
  },
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return tunablePrompt(
      "tool-deliver-files",
      [
        "Hand finished files to the user. Nothing the sandbox writes is shown",
        "to the user by itself — this call is what puts a file in front of",
        "them, as a card in the chat and in the Artifacts panel.",
        "",
        "Deliver ONLY final results: the document, chart, or dataset the user",
        "actually asked for. Do NOT deliver intermediates — helper .csv files,",
        "draft renders, .tex sources behind a delivered .pdf, scratch scripts.",
        "A task that produced fifteen files usually delivers one or two.",
        "",
        "Deliver when a result is ready — usually once, near the end of the",
        "task. Delivering a file again after improving it is fine: the chat",
        "shows it as a new version of the same card.",
      ].join("\n"),
    );
  },
  async description() {
    return "Hand finished files from this chat's sandbox to the user (only delivered files are shown).";
  },
  async call({ files }: z.infer<InputSchema>, context: ToolUseContext) {
    const sessionId =
      (context as { sessionId?: string }).sessionId || "default";
    const lines: string[] = [];
    const delivered: string[] = [];
    const failed: string[] = [];

    for (const raw of files) {
      // The [file] lines show a POSIX relative path; tolerate backslashes and
      // a stray leading "./" from a model quoting its own earlier output.
      const name = raw.replace(/\\/g, "/").replace(/^\.\//, "");
      const abs = resolveSandboxPath(sessionId, name);
      if (!abs) {
        failed.push(`${raw}: invalid path — use a sandbox-relative path.`);
        continue;
      }
      let st;
      try {
        st = statSync(abs);
      } catch {
        failed.push(`${raw}: no such file in the sandbox. Use Glob to see what exists.`);
        continue;
      }
      if (!st.isFile()) {
        failed.push(`${raw}: is a directory — deliver files, not folders.`);
        continue;
      }
      if (st.size > MAX_DELIVER_BYTES) {
        failed.push(`${raw}: too large to deliver (over 100MB).`);
        continue;
      }
      const path = saveArtifactBuffer(sessionId, name, readFileSync(abs));
      const ref = artifactReference(path);
      lines.push(`[artifact] ${mediaTypeOf(name)} ${name} :: ${ref}`);
      lines.push(`Markdown: ![${name}](${ref})`);
      delivered.push(name);
    }

    if (delivered.length > 0)
      lines.push(`Delivered to the user: ${delivered.join(", ")}`);
    if (failed.length > 0) lines.push(`Not delivered:\n${failed.join("\n")}`);
    return {
      data: { text: lines.join("\n"), isError: delivered.length === 0 },
    };
  },
  mapToolResultToToolResultBlockParam(
    content: TextOutput,
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
