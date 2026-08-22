/**
 * What the updater is doing, for whoever wants to show it.
 *
 * Two places ask: the pill above the account card, which appears only when
 * there is something to say, and the About panel, where a person who suspects
 * the app has stopped looking for updates can ask it directly and get an
 * answer either way. The automatic check is deliberately silent about
 * failures — an offline laptop is Tuesday — so "no pill" means BOTH "you are
 * up to date" and "the check never reached GitHub". The manual one has to
 * distinguish them, which is why check() is exposed rather than implied.
 */

import { useCallback, useEffect, useState } from "react";
import type { ElectronAPI, UpdateState } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

export interface UpdateHandle {
  state: UpdateState;
  /** The version running right now, once main has answered. */
  current: string;
  /** True while a manual check is in flight. */
  checking: boolean;
  check: () => Promise<void>;
  download: () => void;
  install: () => void;
}

export function useUpdateState(): UpdateHandle {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const [current, setCurrent] = useState("");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void api()
      ?.updates?.state()
      .then((s) => s && setState(s))
      .catch(() => {});
    void api()
      ?.updates?.currentVersion()
      .then((v) => v && setCurrent(v))
      .catch(() => {});
    return api()?.updates?.onState((s) => setState(s));
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const s = await api()?.updates?.check();
      if (s) setState(s);
    } finally {
      setChecking(false);
    }
  }, []);

  return {
    state,
    current,
    checking,
    check,
    download: () => void api()?.updates?.download(),
    install: () => void api()?.updates?.install(),
  };
}
