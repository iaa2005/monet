/**
 * The verification strip — what the harness is checking, and what it found.
 *
 * The loop runs without being asked, so it must also report without being
 * asked: a turn that quietly spawned three fix turns would look like the
 * model rambling. One slim row: checking → fixing (attempt n/m) → verdict.
 * The verdict stays until the next send; a green run is worth seeing too.
 */

import { AlertTriangle, Loader2, MinusCircle, ShieldCheck, Wrench } from "@/components/icons/hg";
import { useChatStore } from "@/stores/chatStore";

export function VerifyStrip(): JSX.Element | null {
  const verify = useChatStore(
    (s) => s.sessions[s.currentSessionId ?? "default"]?.verify ?? null,
  );
  if (!verify) return null;

  let icon: JSX.Element;
  let text: string;
  switch (verify.phase) {
    case "checking":
      icon = <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />;
      text =
        verify.attempt === 0
          ? "Running project checks…"
          : `Re-running checks after fix ${verify.attempt}/${verify.maxAttempts}…`;
      break;
    case "fixing":
      icon = <Wrench className="size-3.5 shrink-0 text-amber-500" />;
      text = `${verify.check ?? "A check"} failed — fixing (attempt ${verify.attempt}/${verify.maxAttempts})`;
      break;
    case "clean":
      icon = <ShieldCheck className="size-3.5 shrink-0 text-green-text" />;
      text = "Checks passed";
      break;
    case "fixed":
      icon = <ShieldCheck className="size-3.5 shrink-0 text-green-text" />;
      text = `Checks passed after ${verify.attempt} fix${verify.attempt === 1 ? "" : "es"}`;
      break;
    case "gave-up":
      icon = <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />;
      text = `${verify.check ?? "A check"} is still failing — needs you${verify.detail ? ` (${verify.detail})` : ""}`;
      break;
    case "known-red":
      icon = <MinusCircle className="size-3.5 shrink-0 text-muted-foreground" />;
      text = `${verify.check ?? "A check"} was failing before this chat's changes — left alone`;
      break;
  }

  return (
    <div className="mb-2 flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-1.5">
      {icon}
      <span className="min-w-0 truncate text-xs text-muted-foreground" title={text}>
        {text}
      </span>
    </div>
  );
}
