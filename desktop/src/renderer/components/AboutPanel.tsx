import { useState, useEffect } from "react";
import { ExternalLink, Download, RotateCw } from "@/components/icons/hg";
import { useUpdateState } from "@/lib/updates";

const RAW = "https://cdn.jsdelivr.net/gh/iaa2005/monet-paintings@main";

interface Painting {
  title: string;
  year: string;
  filename: string;
  width: number;
  height: number;
  aspect_ratio: number;
}

/**
 * The version, and a way to ask about updates.
 *
 * The automatic check says nothing when it finds nothing — which is right for
 * a pill that exists to interrupt, and useless to someone wondering whether
 * the app still checks at all ("I don't see the update button"). Here the
 * question can be asked out loud, and every answer is an answer: up to date,
 * a version to download, or why the check failed.
 */
function UpdateRow(): JSX.Element {
  const { state, current, checking, check, download, install } = useUpdateState();

  const line = (): JSX.Element => {
    switch (state.status) {
      case "available":
        return (
          <button
            type="button"
            onClick={download}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-link hover:underline"
          >
            <Download className="size-3.5" />
            Download {state.version}
          </button>
        );
      case "downloading":
        return (
          <span className="text-sm text-muted-foreground">
            Downloading {state.version} — {state.percent}%
          </span>
        );
      case "ready":
        return (
          <button
            type="button"
            onClick={install}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-link hover:underline"
          >
            <RotateCw className="size-3.5" />
            Relaunch to update to {state.version}
          </button>
        );
      case "error":
        return (
          <span className="text-sm text-amber-600 dark:text-amber-400">
            {state.message}
          </span>
        );
      default:
        return (
          <button
            type="button"
            onClick={() => void check()}
            disabled={checking}
            className="text-sm font-medium text-link hover:underline disabled:opacity-60"
          >
            {checking ? "Checking…" : "Check for updates"}
          </button>
        );
    }
  };

  return (
    <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
      <span>Version {current || "…"}</span>
      <span aria-hidden>·</span>
      {line()}
    </div>
  );
}

export function AboutPanel(): JSX.Element {
  const [pool, setPool] = useState<Painting[]>([]);
  const [painting, setPainting] = useState<Painting | null>(null);
  const [retries, setRetries] = useState(0);

  const pickRandom = (p: Painting[]) => {
    if (p.length === 0) return null;
    return p[Math.floor(Math.random() * p.length)];
  };

  useEffect(() => {
    fetch(`${RAW}/monet_paintings.json`)
      .then((r) => r.json())
      .then((data: Painting[]) => {
        const filtered = data.filter(
          (p) => p.aspect_ratio <= 0.6 || p.aspect_ratio >= 1.67,
        );
        setPool(filtered);
        setPainting(pickRandom(filtered));
      })
      .catch(() => {});
  }, []);

  const handleImgError = () => {
    if (retries < 3 && pool.length > 1) {
      setRetries((r) => r + 1);
      setPainting(pickRandom(pool.filter((p) => p !== painting)));
    }
  };

  const imgSrc = painting
    ? `${RAW}/${painting.filename}`
    : null;

  const isHorizontal = painting && painting.aspect_ratio >= 1.67;

  const Info = () => (
    <div>
      <h1 className="font-display text-5xl font-normal tracking-tight text-foreground">
        Code Monet
      </h1>
      <div className="mt-3">
        <p className="max-w-sm text-sm leading-relaxed text-foreground">
          Code Monet is a desktop AI agent based on Claude Code. It combines the
          power of large language models with a native desktop experience,
          supporting multiple providers, tool execution, and a rich chat
          interface for software engineering tasks.
        </p>
        <a
          href="https://github.com/iaa2005/monet"
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex w-fit items-center gap-1.5 text-sm font-medium text-link hover:underline"
        >
          Code Monet on GitHub
          <ExternalLink className="size-3.5" />
        </a>
        <UpdateRow />
      </div>
    </div>
  );

  const Artwork = () => (
    <>
      {imgSrc ? (
        <img
          src={imgSrc}
          alt={painting?.title ?? ""}
          className="max-h-full max-w-full"
          onError={handleImgError}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      )}
    </>
  );

  if (isHorizontal) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 items-end gap-6 p-6">
          <div className="flex min-h-0 flex-1 flex-col justify-between self-stretch">
            <h1 className="font-display text-5xl font-normal tracking-tight text-foreground">
              Code Monet
            </h1>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-foreground">
              Code Monet is a desktop AI agent based on Claude Code. It combines the
              power of large language models with a native desktop experience,
              supporting multiple providers, tool execution, and a rich chat
              interface for software engineering tasks.
            </p>
            <a
              href="https://github.com/iaa2005/monet"
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex w-fit items-center gap-1.5 text-sm font-medium text-link hover:underline"
            >
              Code Monet on GitHub
              <ExternalLink className="size-3.5" />
            </a>
            <UpdateRow />
          </div>
          <div className="shrink-0 self-end text-right">
            <div className="text-sm text-muted-foreground">
              {painting?.title}, {painting?.year}
            </div>
          </div>
        </div>
        <div className="shrink-0">
          <Artwork />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="shrink-0 self-stretch">
        <Artwork />
      </div>
      <div className="flex flex-1 flex-col justify-between p-8">
        <Info />
        <div className="text-sm text-muted-foreground">
          {painting?.title}, {painting?.year}
        </div>
      </div>
    </div>
  );
}
