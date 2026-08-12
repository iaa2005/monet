/**
 * AgentSwarm — one task, repeated over a list, run several at a time.
 *
 * Sits alongside Task/SendMessage/TeamList rather than replacing them, because
 * they answer a different question. Task plus SendMessage builds a TEAM: agents
 * that differ from one another and talk. A swarm is a BATCH: the same
 * instruction applied to twenty files, twenty agents that never need to know
 * about each other, one report at the end.
 *
 * Doing that with Task today means the model emitting twenty tool calls and —
 * since Task is not concurrency-safe — waiting for each in turn. Here they
 * overlap, under a bounded, staggered pool (see swarm-pool.ts).
 *
 * No exclusivity rule. Kimi Code requires AgentSwarm to be the only call in
 * its response; that guards against a turn whose shape is hard to follow, but
 * a call after the swarm could not use its results in any case — nothing in a
 * response sees another call's output — so the constraint would buy nothing
 * here.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { getCwd } from "@vendor/utils/cwd.js";
import { lazySchema } from "./lazy-schema.js";
import { describeAgentsForPrompt, resolveAgentDefinition } from "./agent-defs.js";
import { runSubAgent } from "./subagent.js";
import {
  buildSwarmReport,
  ITEM_PLACEHOLDER,
  MAX_ITEMS,
  runSwarm,
} from "./swarm-pool.js";
import { tunablePrompt } from "../prompts/index.js";

/** Alive at once. Each is a full model loop, so this is deliberately modest. */
const DEFAULT_CONCURRENCY = 4;
/** May start without waiting, before the stagger applies. */
const START_BURST = 2;
/** Minimum gap between starts once past the burst. */
const STAGGER_MS = 700;

function concurrencyLimit(): number {
  const raw = process.env.MONET_SWARM_CONCURRENCY;
  if (!raw) return DEFAULT_CONCURRENCY;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_ITEMS) : DEFAULT_CONCURRENCY;
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    prompt_template: z
      .string()
      .describe(
        `The task, written once, with ${ITEM_PLACEHOLDER} where each item goes. Each sub-agent starts with no context beyond this text, so spell out what to do and what to report back.`,
      ),
    items: z
      .array(z.string())
      .describe(
        "What to run the template over — file paths, component names, ticket ids. One sub-agent per item.",
      ),
    subagent_type: z
      .string()
      .optional()
      .describe(
        "Which agent type every member of the swarm uses. Defaults to general-purpose.",
      ),
    description: z
      .string()
      .optional()
      .describe("A short (3-5 word) label for the swarm."),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

interface SwarmOutput {
  report: string;
  isError?: boolean;
}

const mapResult = (
  data: SwarmOutput,
  toolUseID: string,
): ToolResultBlockParam => ({
  type: "tool_result",
  tool_use_id: toolUseID,
  content: data.report,
  is_error: data.isError || undefined,
});

const fail = (report: string): { data: SwarmOutput } => ({
  data: { report, isError: true },
});

export const AgentSwarmTool = buildTool({
  name: "AgentSwarm",
  searchHint: "run one task over many items in parallel batch",
  maxResultSizeChars: 200_000,
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  userFacingName() {
    return "AgentSwarm";
  },
  isReadOnly() {
    return false;
  },
  // Never batched with anything: it is already running several agents, and a
  // second heavy tool alongside it would multiply the load.
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return tunablePrompt(
      "tool-agent-swarm",
      [
        `Run ONE task over a LIST, several at a time. Write the task once in`,
        `prompt_template with ${ITEM_PLACEHOLDER} where the item goes, and pass`,
        `the list in items. Each item gets its own sub-agent with its own`,
        `context; you get one combined report when they have all finished.`,
        "",
        "Use it when the same instruction repeats over many things — review each",
        "of these files, migrate each of these components, summarise each of",
        "these tickets. The items must be independent: the agents cannot see",
        "each other or share findings.",
        "",
        "Use Task instead for a single piece of work, and Task with",
        "run_in_background plus SendMessage when the agents differ from one",
        "another or need to talk. A swarm is a batch, not a team.",
        "",
        `At most ${MAX_ITEMS} items. Each one costs a full agent run, so do not`,
        "swarm what a single grep would answer.",
        "",
        describeAgentsForPrompt(),
      ].join("\n"),
    );
  },
  async description() {
    return "Run one task template over a list of items, several sub-agents at a time.";
  },
  async call(
    { prompt_template, items, subagent_type }: z.infer<InputSchema>,
    context: ToolUseContext,
  ) {
    if (!prompt_template.includes(ITEM_PLACEHOLDER))
      return fail(
        `prompt_template must contain ${ITEM_PLACEHOLDER} — that is where each ` +
          `item is substituted. Without it every sub-agent would get an identical task.`,
      );

    const cleaned = items.map((i) => i.trim()).filter(Boolean);
    if (cleaned.length < 2)
      return fail(
        "A swarm needs at least 2 items. For a single task use the Task tool.",
      );
    if (cleaned.length > MAX_ITEMS)
      return fail(
        `${cleaned.length} items is over the limit of ${MAX_ITEMS}. Each item is a ` +
          `full agent run. Narrow the list, or run it in several swarms.`,
      );

    const model = context.options.mainLoopModel;
    const cwd = getCwd();
    const def = resolveAgentDefinition(subagent_type, cwd);
    const signal = context.abortController?.signal;
    // The executor hangs the turn's progress callback here; it is what puts
    // live text on the tool card while a long call runs.
    const onProgress = (
      context as { _subAgentOnProgress?: (text: string) => void }
    )._subAgentOnProgress;

    const outcomes = await runSwarm<string>(
      cleaned,
      (item) =>
        runSubAgent({
          prompt: prompt_template.split(ITEM_PLACEHOLDER).join(item),
          model,
          def,
          signal,
          cwd,
        }),
      {
        concurrency: concurrencyLimit(),
        staggerMs: STAGGER_MS,
        burst: START_BURST,
        isAborted: () => signal?.aborted === true,
        onSettled: (done, total, failures) => {
          onProgress?.(
            `Swarm: ${done}/${total} finished` +
              (failures ? ` (${failures} failed)` : ""),
          );
        },
      },
    );

    return { data: { report: buildSwarmReport(outcomes) } };
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});
