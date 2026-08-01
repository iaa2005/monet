/**
 * Two decisions the transcript makes on every render, extracted so they can be
 * asserted without a browser: whether to show the "Working" row, and which
 * item carries a turn's Copy button.
 *
 * Both were reported wrong together. A model writing a large file streams its
 * tool INPUT for minutes with no visible text; the rule that asked "is the
 * last assistant message flagged streaming and non-empty" read that as text
 * arriving, so the Working row disappeared and a Copy button showed up under
 * a half-written turn while the stop button was still red.
 */

/** What the transcript shows, reduced to what these rules care about. */
export interface TurnItem {
  /** A chat message, or anything else in the stream (tool group, artifacts). */
  kind: "message" | "other";
  role?: "user" | "assistant" | "tool";
  content?: string;
}

/**
 * The "Working" row belongs on screen whenever a run is in flight and text is
 * NOT currently arriving. `textFlowing` is measured by growth of the visible
 * content (see useTextFlowing in ChatView), not by a streaming flag: the flag
 * stays set for the whole turn, including the long silences while the model
 * composes a tool call.
 */
export function shouldShowWorking({
  streaming,
  textFlowing,
}: {
  streaming: boolean;
  textFlowing: boolean;
}): boolean {
  return streaming && !textFlowing;
}

/**
 * Which index carries each turn's Copy button, and what it copies.
 *
 * A turn is the assistant text (possibly several messages, with tool groups
 * between them) that follows a user message; the button sits on its LAST item
 * so it lands under everything the turn produced. While a run is in flight the
 * final turn is skipped — half an answer is not a thing to copy.
 */
export function copyTargets(
  items: TurnItem[],
  streaming: boolean,
): Map<number, string> {
  const out = new Map<number, string>();
  let parts: string[] = [];
  let lastIdx = -1;

  const flush = (): void => {
    if (parts.length > 0 && lastIdx >= 0) out.set(lastIdx, parts.join("\n\n"));
    parts = [];
    lastIdx = -1;
  };

  items.forEach((item, i) => {
    if (item.kind !== "message") {
      // Tool groups and artifact strips belong to the turn around them.
      if (parts.length > 0) lastIdx = i;
      return;
    }
    if (item.role === "user") {
      flush();
      return;
    }
    if (item.role === "assistant" && item.content) {
      parts.push(item.content);
      lastIdx = i;
    }
  });
  flush();

  // The turn still being written owns the tail of the list; drop its button.
  if (streaming && items.length > 0) {
    for (const idx of [...out.keys()].sort((a, b) => b - a)) {
      const afterIsUser = items
        .slice(idx + 1)
        .some((x) => x.kind === "message" && x.role === "user");
      if (!afterIsUser) out.delete(idx);
      break;
    }
  }
  return out;
}

/**
 * Tools that render as their own CARD rather than as a row in a tool group.
 *
 * The plan is the case that matters: its card carries the Build buttons, and
 * a grouped call never reaches the card renderer — the approval then waits
 * for its ten-minute timeout with nothing on screen to answer it. Grouping
 * asks this before folding a call in, so the rule lives in one place instead
 * of being spread between the grouper and the bubble.
 */
export function rendersAsCard(toolName: string | undefined): boolean {
  return toolName === "ExitPlanMode";
}
