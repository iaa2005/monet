/**
 * Did the stream END, or did it just STOP?
 *
 * Every provider says how a turn finished — `finish_reason` on the OpenAI
 * wire, `message_delta.stop_reason` on Anthropic's. When the connection drops
 * instead, that word never arrives, and both clients used to fill the gap with
 * the friendliest possible guess: `end_turn`. A dropped connection then
 * reached the agent looking exactly like a model that had answered with
 * nothing — which has its own cure, the nudge, and the nudge re-sends the
 * entire request.
 *
 * Seen in the field, on a 27B running on the CPU:
 *
 *   done in 252352ms: text=0 chars, stop_reason=end_turn, chunks=10,
 *   progress=10, tool_calls=0, leftover=38
 *
 * Ten chunks, ten of them prefill progress: not one byte of answer, no
 * finish_reason, and a final SSE frame cut off mid-line. Four minutes of
 * reading the prompt, the server went away, and the harness said "the model
 * answered with nothing — nudging it to continue", which spent another four
 * minutes reading the same prompt into the same wall.
 *
 * So: a stream that carried no verdict AND no output did not end, it broke,
 * and it is reported as the error it is. `streamFailed` then suppresses the
 * nudge (see agent/empty-turn.ts) and the user is told what happened rather
 * than being shown a silent, empty turn.
 *
 * A stream that carried output but no verdict is NOT called broken here. It
 * is very likely truncated, but the answer is on screen and some
 * OpenAI-compatible servers are simply careless with the last chunk — calling
 * that a dropped connection would put a red box under a reply that is
 * perfectly fine, which is a worse lie than the one being fixed.
 */

export interface StreamEnd {
  /** The provider's own word for how the turn ended, if it ever came. */
  finishReason?: string | null;
  /** Characters of visible answer. */
  textLen: number;
  /** Characters of reasoning — output too, even though it is not the answer. */
  reasoningLen: number;
  /** Tool calls accumulated over the stream. */
  toolCalls: number;
  /** How many prefill-progress chunks arrived (local servers narrate these). */
  progressChunks: number;
  /** Characters left unparsed in the buffer — a frame cut mid-line. */
  leftover: number;
}

/**
 * The message to report, or null when the stream ended properly.
 *
 * Worded for the person reading it: what the server was doing when it went
 * away is the difference between "your prompt is too long for this machine"
 * and "the model is misbehaving", and the progress chunks say which.
 */
export function droppedStream(end: StreamEnd): string | null {
  // The server said how it finished. Whatever else is odd, it is not this.
  if (end.finishReason) return null;
  // Something came back. Not our business to call it broken — see the note
  // at the top of the file.
  if (end.textLen > 0 || end.reasoningLen > 0 || end.toolCalls > 0) return null;

  const cut = end.leftover > 0 ? " The last message was cut off mid-frame." : "";
  if (end.progressChunks > 0) {
    return (
      `The connection dropped while the server was still reading the prompt ` +
      `— ${end.progressChunks} progress update${end.progressChunks === 1 ? "" : "s"} ` +
      `and no answer.${cut} Nothing was generated, so nothing was lost; the ` +
      `prompt is what the machine could not get through.`
    );
  }
  return (
    `The stream ended without an answer and without saying why — no text, no ` +
    `tool calls, and no finish reason.${cut} The connection was dropped rather ` +
    `than the turn being finished.`
  );
}
