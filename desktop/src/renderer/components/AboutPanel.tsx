import { useState, useEffect } from "react";
import { ExternalLink } from "lucide-react";

const RAW = "https://cdn.jsdelivr.net/gh/iaa2005/monet-paintings@main";

interface Painting {
  title: string;
  year: string;
  filename: string;
  width: number;
  height: number;
  aspect_ratio: number;
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
      <h1 className="font-[Copernicus] text-5xl font-semibold tracking-tight text-foreground">
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
            <h1 className="font-[Copernicus] text-5xl font-semibold tracking-tight text-foreground">
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
