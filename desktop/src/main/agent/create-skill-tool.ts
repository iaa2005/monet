/**
 * CreateSkill tool (desktop-native).
 *
 * Lets the model write a new skill during a turn: a folder under the user's
 * skills directory holding a SKILL.md and, optionally, files it refers to. The
 * skill becomes a slash command the moment it lands, because the vendor
 * discovers commands from that directory — so `/release-notes` works without a
 * restart, once the caches are dropped.
 *
 * The counterpart of the `Skill` tool, which RUNS one. Everything checkable
 * about a draft lives in skill-authoring.ts; this file is where it meets the
 * filesystem.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "../engine/Tool.js";
import { lazySchema } from "./lazy-schema.js";
import { tunablePrompt } from "../prompts/index.js";
import { getDataDir } from "../data-dir.js";
import { prepareSkill } from "./skill-authoring.js";

interface Output {
  text: string;
  isError: boolean;
}

const out = (text: string, isError = false): { data: Output } => ({
  data: { text, isError },
});

function skillsRoot(): string {
  const dir = join(getDataDir(), "claude", "skills");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    name: z
      .string()
      .describe(
        "Folder name and the slash command, kebab-case: `release-notes` becomes /release-notes.",
      ),
    description: z
      .string()
      .describe(
        "One line saying WHEN this skill applies. This is what the agent matches on, so lead with the trigger, not the mechanics.",
      ),
    body: z
      .string()
      .describe(
        "The instructions, in markdown. Short and imperative, in the order they should be done.",
      ),
    files: z
      .array(
        z.object({
          path: z
            .string()
            .describe("Relative to the skill's folder, e.g. `scripts/run.py`."),
          content: z.string(),
        }),
      )
      .optional()
      .describe("Extra files the skill refers to. SKILL.md comes from `body`."),
    overwrite: z
      .boolean()
      .default(false)
      .describe("Replace a skill of the same name. Off by default."),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const PROMPT_DEFAULT = [
  "Write a new skill: a folder holding SKILL.md, plus any files it refers to.",
  "It becomes a slash command immediately — `release-notes` is /release-notes.",
  "",
  "The DESCRIPTION is the whole game. It is what gets matched when deciding",
  "whether to load the skill, so say when it applies, in the words someone",
  "would actually use: “Use when writing release notes from a range of git",
  "commits”, not “Release notes helper”. A vague description is how a skill",
  "ends up never being used.",
  "",
  "Keep the BODY short and imperative, in the order the steps happen. It is",
  "loaded into a live context, so every paragraph costs tokens on the turn it",
  "is used. Put long reference material in a file and point at it.",
  "",
  "Create one when the user asks for a skill, or when a procedure they have",
  "just walked you through is worth having next time. Do not create one to",
  "record a fact about the user — that is Remember — and do not create one",
  "for something the model already does well without instructions.",
].join("\n");

export const CreateSkillTool = buildTool({
  name: "CreateSkill",
  searchHint: "write a new skill (slash command) into the user's skills folder",
  maxResultSizeChars: 4_000,
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  userFacingName() {
    return "CreateSkill";
  },
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return tunablePrompt("tool-create-skill", PROMPT_DEFAULT);
  },
  async description() {
    return "Create a new skill (a slash command) in the user's skills folder.";
  },
  async call(input: z.infer<InputSchema>, _context: ToolUseContext) {
    const draft = prepareSkill({
      name: input.name,
      description: input.description,
      body: input.body,
      files: input.files,
    });
    if (!draft.ok) return out(draft.error, true);

    const root = skillsRoot();
    const dir = join(root, draft.slug);
    if (existsSync(dir) && !input.overwrite) {
      const existing = readdirSync(dir).slice(0, 12).join(", ");
      return out(
        `A skill named ${draft.slug} already exists (${existing}). ` +
          `Pass overwrite: true to replace it, or pick another name.`,
        true,
      );
    }

    try {
      const written: string[] = [];
      const put = (rel: string, content: string): void => {
        const target = join(dir, rel);
        // Belt and braces. `prepareSkill` already refuses anything that could
        // climb out, and this is the line that would let it if it ever stopped:
        // a path is only written when it really resolves inside the folder.
        const inside = resolve(dir);
        if (resolve(target) !== inside && !resolve(target).startsWith(inside + sep))
          throw new Error(`refused to write outside the skill folder: ${rel}`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf-8");
        written.push(rel);
      };

      put("SKILL.md", draft.skillMd);
      for (const f of draft.files) put(f.path, f.content);

      // Drop the caches, the way installing from the Directory does, so the new
      // command answers in this same session rather than after a restart.
      await import("../skills/loader/loadSkillsDir.js")
        .then((m) => (m as { clearSkillCaches?: () => void }).clearSkillCaches?.())
        .catch(() => {});
      await import("./vendor-tools.js")
        .then((m) => m.resetVendorTools?.())
        .catch(() => {});

      return out(
        [
          `Created /${draft.slug} in ${dir}`,
          `Files: ${written.join(", ")}`,
          "",
          "It is available now — the user can run it as a slash command, and it",
          "is listed in Settings → Skills.",
        ].join("\n"),
      );
    } catch (err) {
      return out(
        `Could not write the skill: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
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
