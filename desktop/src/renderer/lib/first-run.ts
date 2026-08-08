/**
 * Is this a first run?
 *
 * It looks like a one-line question and it has now been got wrong three
 * times, so it lives here with a probe.
 *
 * The state belongs to the DATA FOLDER — that is where the chats, the models
 * and the settings are, and pointing the app at a different folder is
 * starting again by definition. It was kept in localStorage, which is keyed
 * by ORIGIN: in dev the origin carries vite's port, so a moved port
 * re-greeted somebody who had been using the app for months.
 *
 * Two attempts to be clever about installs that predate the flag both
 * failed, in opposite directions. Honouring the old localStorage flag hid
 * the setup from a brand new folder, because the browser still remembered an
 * install that had nothing to do with it. Reading "has this folder been
 * used?" off the chat count hid it too — measured on the shipped app: a fresh
 * folder has a chat in it within a second of opening, because the chat view
 * makes one.
 *
 * So there is no inference left. The file says it, or it does not. An
 * existing install sees the setup once and is flagged; seven Continues is a
 * smaller price than a first run with no setup at all, and it is a price
 * paid once rather than a rule nobody can predict.
 */

export interface FirstRunFacts {
  /** ui-prefs.json says the setup was completed. Null = no bridge yet. */
  onboarded: boolean | null;
}

export type FirstRunVerdict =
  /** Show the setup. */
  | "onboard"
  /** Already set up — nothing to do. */
  | "skip"
  /** No bridge (a probe, a bare browser). Not a first run, not an install. */
  | "unknown";

export function firstRunVerdict(facts: FirstRunFacts): FirstRunVerdict {
  if (facts.onboarded === null) return "unknown";
  return facts.onboarded ? "skip" : "onboard";
}
