/**
 * The chat the user is looking at, as the renderer last reported.
 *
 * A module of its own with zero imports: the browser transport needs this
 * SYNCHRONOUSLY to route a run to the visible panel or the hidden layer, and
 * importing ipc/chat.js from there is a dependency cycle.
 */

let visible: string | undefined;

export function setVisibleChatSession(id: string | undefined): void {
  visible = id;
}

export function getVisibleChatSession(): string | undefined {
  return visible;
}
