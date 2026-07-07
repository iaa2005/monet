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
    api()?.workspace.get().then(setWorkspace).catch(() => {});
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
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground disabled:opacity-50 dark:hover:bg-white/[0.06]"
    >
      <FolderOpen className="size-4 shrink-0" />
      <span className="truncate">{displayPath}</span>
    </button>
  );
}
