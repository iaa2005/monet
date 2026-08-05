/**
 * "Your chat is done" — but only when you were not watching it.
 *
 * A notification for something already on screen is noise, and noise is how
 * a user learns to turn notifications off. So this fires on exactly the cases
 * where the answer arrived somewhere the user could not see it:
 *
 *   - the window is hidden, minimised, or behind another app;
 *   - or it is right there, but the chat that finished is not the one open.
 *
 * Never for a routine: those already have their own "notification" output,
 * and a scheduled run the user set up on purpose is not news.
 *
 * The decision is pure and lives apart from Electron so the rules can be
 * pinned down — every one of them is a judgement about whether to interrupt
 * a person, which is not a thing to get wrong quietly.
 */

export interface TurnEndFacts {
  /** The chat whose turn just ended. */
  sessionId: string;
  /** The chat the renderer is showing, if the window is even up. */
  visibleSessionId?: string;
  /** Window is up, not minimised, and has focus. */
  windowFocused: boolean;
  /** Window exists and is on screen at all (tray-hidden counts as false). */
  windowVisible: boolean;
  /** Scheduled runs speak for themselves. */
  isRoutineChat: boolean;
  /** The user pressed Stop — they are at the keyboard by definition. */
  aborted: boolean;
}

export type NotifyDecision =
  | { notify: false; because: string }
  | { notify: true; because: "window-away" | "other-chat" };

export function shouldNotifyTurnEnd(f: TurnEndFacts): NotifyDecision {
  if (f.isRoutineChat) return { notify: false, because: "routine" };
  if (f.aborted) return { notify: false, because: "user stopped it" };
  // Away beats everything: a hidden window means nothing was seen, whatever
  // chat it was left on.
  if (!f.windowVisible || !f.windowFocused)
    return { notify: true, because: "window-away" };
  if (f.visibleSessionId !== f.sessionId)
    return { notify: true, because: "other-chat" };
  return { notify: false, because: "you were looking at it" };
}

/** First line of the reply, short enough for a notification body. */
export function notificationBody(text: string, error?: string): string {
  if (error) return error.slice(0, 140);
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "Finished.";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}
