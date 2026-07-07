import { useState } from "react";
import { ProviderSettings } from "@/components/providers/ProviderSettings";
import { ChatView, usePermissionHandler } from "@/components/chat/ChatView";
import { Button } from "@/components/ui/button";

type Tab = "chat" | "providers";

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>("chat");

  // Listen for permission requests
  usePermissionHandler();

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <h1 className="text-lg font-bold">Claude Code Desktop</h1>
        <div className="flex gap-1">
          <Button
            variant={tab === "chat" ? "default" : "outline"}
            size="sm"
            onClick={() => setTab("chat")}
          >
            Chat
          </Button>
          <Button
            variant={tab === "providers" ? "default" : "outline"}
            size="sm"
            onClick={() => setTab("providers")}
          >
            Settings
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        {tab === "chat" && <ChatView />}
        {tab === "providers" && (
          <div className="p-6">
            <ProviderSettings />
          </div>
        )}
      </main>
    </div>
  );
}
