/**
 * The shape of first run.
 *
 * A list rather than a switch statement, because three things have to agree
 * about it and only one of them draws anything: the progress bar needs to
 * know how many steps there are, the Skip button needs to know which step it
 * is on (the welcome has none — a Skip there would mean "skip the whole
 * setup", which is a different button), and the header needs a title.
 *
 * Every step after the first is skippable and none of them is required:
 * the app works with no vault, no models, no avatar. What it does NOT work
 * without is a provider, which is why that one is last — the step you are
 * most likely to finish is the one that comes after everything you might
 * abandon.
 */

export type StepId =
  | "welcome"
  | "folder"
  | "you"
  | "look"
  | "voice"
  | "ocr"
  | "vault"
  | "provider";

export interface StepSpec {
  id: StepId;
  /** Shown above the step. Short — it is a label, not a sentence. */
  title: string;
  /** One line under it. Shorter still. */
  hint?: string;
}

export const STEPS: StepSpec[] = [
  { id: "welcome", title: "Code Monet" },
  {
    id: "folder",
    title: "Where your data lives",
    hint: "Chats, memory, models and settings — all in one folder you own.",
  },
  {
    id: "you",
    title: "About you",
    hint: "So the agent knows who it is working with. Both optional.",
  },
  { id: "look", title: "How it looks", hint: "Change it any time in Settings." },
  {
    id: "voice",
    title: "Talking to it",
    hint: "Dictate instead of typing, or hold a conversation out loud.",
  },
  {
    id: "ocr",
    title: "Reading documents",
    hint: "Scan a PDF or a photo of a page into text the agent can use.",
  },
  {
    id: "vault",
    title: "Obsidian",
    hint: "Point it at a vault and your notes become part of the conversation.",
  },
  {
    id: "provider",
    title: "The model",
    hint: "One API key and you are done. Free ones exist.",
  },
];

/** 0…1 — how much of the setup is behind you. */
export function progressAt(index: number): number {
  if (STEPS.length <= 1) return 1;
  return Math.min(1, Math.max(0, index / (STEPS.length - 1)));
}

/** Skipping is per-step, and the welcome is not a step you skip. */
export function canSkip(index: number): boolean {
  return index > 0 && index < STEPS.length;
}

/** "Step 3 of 8" — but not on the welcome, where there is nothing behind you. */
export function stepLabel(index: number): string | null {
  if (index <= 0) return null;
  return `Step ${index} of ${STEPS.length - 1}`;
}
