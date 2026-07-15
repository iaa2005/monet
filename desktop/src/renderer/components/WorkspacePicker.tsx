import { useState, useEffect } from "react";
import { FolderOpen } from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

export function WorkspacePicker(): JSX.Element {
  const [workspace, setWorkspace] = useState("");
  const [picking, setPicking] = useState(false);
  // Re-fetch whenever the effective directory changes elsewhere (e.g. opening
  // a chat restores that chat's own saved folder).
  const workspaceVersion = useChatStore((s) => s.workspaceVersion);

  useEffect(() => {
    api()
      ?.workspace.get()
      .then(setWorkspace)
      .catch(() => {});
  }, [workspaceVersion]);

  const handlePick = async (): Promise<void> => {
    setPicking(true);
    try {
      const dir = await api()?.files.pickDirectory();
      if (dir) {
        await api()?.workspace.set(dir);
        setWorkspace(dir);
        // The folder choice belongs to THIS chat — remember it on the session
        // so reopening the chat restores it.
        const sessionId = useChatStore.getState().currentSessionId;
        if (sessionId && !sessionId.startsWith("incognito-")) {
          void api()?.sessions.setWorkspace(sessionId, dir);
        }
        useChatStore.getState().bumpWorkspace();
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
      className="glass-panel flex w-fit items-center gap-2 rounded-md border border-border px-2.5 py-1 text-left text-[12px] transition-colors bg-black/[0.05] text-foreground hover:bg-black/[0.08] disabled:opacity-50 dark:bg-white/[0.06] dark:hover:bg-white/[0.1]"
    >
      <FolderOpen className="size-4 shrink-0" />
      <span className="truncate">{displayPath}</span>
    </button>
  );
}
