/**
 * What the Browser panel shows before it has a page.
 *
 * The dev-server list is the point. Nine times out of ten the thing you want
 * open is already running on some port you half remember, and typing the wrong
 * one is how you end up debugging a page that isn't the one you changed.
 */

import { useState } from "react";
import { Globe, Loader2, Radar } from "lucide-react";
import type { DevServer, ElectronAPI } from "@/types/electron";

interface EmptyStateProps {
  onOpen: (url: string) => void;
}

export function BrowserEmptyState({ onOpen }: EmptyStateProps): JSX.Element {
  const [servers, setServers] = useState<DevServer[] | null>(null);
  const [scanning, setScanning] = useState(false);

  const scan = async (): Promise<void> => {
    setScanning(true);
    try {
      const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI;
      setServers(await api.browser.devServers());
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <Globe className="size-7 text-muted-foreground/60" />
      <div className="text-sm font-medium">Browse and verify</div>
      <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
        The agent can open pages, click through them and read the console here.
        Type a URL above to start.
      </p>

      {servers === null ? (
        <button
          type="button"
          onClick={() => void scan()}
          disabled={scanning}
          className="mt-1 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground disabled:opacity-60 dark:hover:bg-white/[0.08]"
        >
          {scanning ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Radar className="size-3.5" />
          )}
          Running your app? Find the dev server
        </button>
      ) : servers.length === 0 ? (
        <div className="mt-1 space-y-2">
          <p className="text-xs text-muted-foreground">
            Nothing is serving HTML on the usual ports.
          </p>
          <button
            type="button"
            onClick={() => void scan()}
            className="text-xs text-link underline-offset-2 hover:underline"
          >
            Scan again
          </button>
        </div>
      ) : (
        <div className="mt-1 w-full max-w-xs space-y-1">
          {servers.map((s) => (
            <button
              key={s.port}
              type="button"
              onClick={() => onOpen(s.url)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
            >
              <span className="font-medium">:{s.port}</span>
              <span className="truncate text-muted-foreground">
                {s.title || s.url}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
