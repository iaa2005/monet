/**
 * Orange "beta" flag next to the wordmark — shown only in time-limited beta
 * builds (MONET_BETA_EXPIRES baked in at build time). The tooltip says when
 * the build stops working; the main process enforces the deadline itself
 * (src/main/app/beta.ts), this badge is just the honest label.
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

export function BetaBadge(): JSX.Element | null {
  const at = expiry();
  if (!at) return null;
  const daysLeft = Math.max(0, Math.ceil((at.getTime() - Date.now()) / 86_400_000));
  return (
    <span
      title={`Beta build — works until ${at.toLocaleDateString()} (${daysLeft} day${daysLeft === 1 ? "" : "s"} left)`}
      className="app-no-drag ml-1.5 inline-flex select-none items-center rounded-full bg-orange-500/15 px-1.5 py-0.5 align-middle text-[10px] font-semibold lowercase leading-none text-orange-600 dark:bg-orange-400/15 dark:text-orange-400"
    >
      BETA
    </span>
  );
}
