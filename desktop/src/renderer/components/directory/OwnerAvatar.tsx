/**
 * The GitHub owner's avatar, for telling one card's origin from another's.
 *
 * `github.com/<owner>.png?size=N` needs no API call and no token — it 302s to
 * avatars.githubusercontent.com and the browser follows it. Verified: microsoft,
 * anthropics, vercel-labs and k-dense-ai all resolve to a PNG; an owner that
 * does not exist returns 404, which is why the failure path below is not
 * theoretical.
 *
 * On failure it falls back to the owner's initial rather than leaving a broken
 * image: a torn-page icon in a grid of a hundred cards reads as the app being
 * broken, not as one avatar being unavailable.
 */

import { useState } from "react";
import { cn } from "@/lib/utils";
import { avatarOwner, ownerOf } from "./source-labels";

export { avatarOwner, ownerOf };

export function OwnerAvatar({
  owner,
  size = 20,
  className,
}: {
  owner: string;
  size?: number;
  className?: string;
}): JSX.Element | null {
  const [failed, setFailed] = useState(false);
  if (!owner) return null;

  const box = cn(
    "mt-0.5 shrink-0 overflow-hidden rounded-md bg-black/[0.06] dark:bg-white/[0.08]",
    className,
  );
  const style = { width: size, height: size };

  if (failed)
    return (
      <span
        style={style}
        className={cn(box, "flex items-center justify-center text-[10px] font-semibold uppercase text-muted-foreground")}
        title={owner}
        aria-hidden
      >
        {owner[0]}
      </span>
    );

  return (
    <img
      // Asking for 2x keeps it sharp on a HiDPI screen; the file is ~300 bytes.
      src={`https://github.com/${encodeURIComponent(owner)}.png?size=${size * 2}`}
      alt=""
      aria-hidden
      loading="lazy"
      decoding="async"
      style={style}
      className={box}
      onError={() => setFailed(true)}
      title={owner}
    />
  );
}
