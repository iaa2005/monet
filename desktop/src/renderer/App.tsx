import { useState } from "react";
import { ProviderSettings } from "@/components/providers/ProviderSettings";
import { Button } from "@/components/ui/button";

export default function App(): JSX.Element {
  const [showProviders, setShowProviders] = useState(false);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <h1 className="text-lg font-bold">Claude Code Desktop</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowProviders(!showProviders)}
        >
          {showProviders ? "Hide" : "Settings"}
        </Button>
      </header>

      <main className="flex-1 overflow-auto p-6">
        {showProviders ? (
          <ProviderSettings />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <p>Chat interface coming in Stage 2</p>
          </div>
        )}
      </main>
    </div>
  );
}
