import { useState, useEffect } from "react";
import { FolderOpen } from "lucide-react";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

export function WorkspacePicker(): JSX.Element {
  const [workspace, setWorkspace] = useState("");
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    api()
      ?.workspace.get()
      .then(setWorkspace)
      .catch(() => {});
  }, []);

  const handlePick = async (): Promise<void> => {
    setPicking(true);
    try {
      const dir = await api()?.files.pickDirectory();
      if (dir) {
        await api()?.workspace.set(dir);
        setWorkspace(dir);
      }
    } finally {
      setPicking(false);
    }
  };

  const displayPath = workspace
    ? workspace.split(/[/\\]/).slice(-2).join("/")
    : "Open folder…";

  return (
    <button
      type="button"
      onClick={handlePick}
      disabled={picking}
      title={workspace}
      className="flex w-fit items-center gap-2 rounded-md px-2.5 py-1 text-left text-[12px] transition-colors bg-black/[0.05] text-foreground hover:bg-black/[0.08] disabled:opacity-50 dark:bg-white/[0.06] dark:hover:bg-white/[0.1]"
    >
      <FolderOpen className="size-4 shrink-0" />
      <span className="truncate">{displayPath}</span>
    </button>
  );
}
