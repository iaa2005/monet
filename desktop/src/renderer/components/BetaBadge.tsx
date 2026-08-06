/**
 * The chip next to the wordmark that says which build this is.
 *
 * Two builds are worth labelling, and they never coexist:
 *
 *   dev  — running from the dev server. Blue, because it is a fact about
 *          the machine rather than a warning: nothing expires, and nothing
 *          about it should read as urgent.
 *   beta — a time-limited build (MONET_BETA_EXPIRES baked in at build
 *          time). Orange, with the deadline in the tooltip; the main
 *          process enforces it (src/main/app/beta.ts), this is the label.
 *
 * dev wins when both are true: a developer running a beta bundle from the
 * dev server is developing, and the countdown is not the interesting fact.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function expiry(): Date | null {
  const raw =
    typeof __BETA_EXPIRES__ === "string" ? __BETA_EXPIRES__.trim() : "";
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return null;
  // Date-only deadlines are valid THROUGH that day (same rule as main).
  return new Date(DATE_ONLY.test(raw) ? ts + 24 * 3_600_000 : ts);
}

const CHIP =
  "app-no-drag ml-1.5 inline-flex select-none items-center rounded-full px-1.5 py-0.5 align-middle text-[10px] font-semibold lowercase leading-none";

export function BetaBadge(): JSX.Element | null {
  if (import.meta.env.DEV)
    return (
      <span
        title="Development build — running from the dev server"
        className={`${CHIP} bg-sky-500/15 text-sky-600 dark:bg-sky-400/15 dark:text-sky-400`}
      >
        DEV
      </span>
    );

  const at = expiry();
  if (!at) return null;
  const daysLeft = Math.max(0, Math.ceil((at.getTime() - Date.now()) / 86_400_000));
  return (
    <span
      title={`Beta build — works until ${at.toLocaleDateString()} (${daysLeft} day${daysLeft === 1 ? "" : "s"} left)`}
      className={`${CHIP} bg-orange-500/15 text-orange-600 dark:bg-orange-400/15 dark:text-orange-400`}
    >
      BETA
    </span>
  );
}
