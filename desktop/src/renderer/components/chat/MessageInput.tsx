import { useState, useRef, useEffect } from "react";
import { ArrowUp, ChevronDown, Mic, Plus, Square, X, FileText } from "lucide-react";
import {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
} from "@/components/ui/attachment";
import { useChatStore } from "@/stores/chatStore";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

interface StagedFile {
  id: string;
  file: File;
  url?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

export function MessageInput(): JSX.Element {
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [model, setModel] = useState<string>("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const {
    addUserMessage,
    addAssistantMessage,
    handleLLMEvent,
    setError,
    isStreaming,
  } = useChatStore();

  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    }
  }, [input]);

  useEffect(() => {
    api()
      ?.providers.getActive()
      .then((p) => {
        const prov = p as { model?: string; name?: string } | undefined;
        if (prov) setModel(prov.model || prov.name || "");
      })
      .catch(() => {});
  }, []);

  const stageFiles = (list: FileList | null): void => {
    if (!list) return;
    setFiles((prev) => [
      ...prev,
      ...Array.from(list).map((file) => ({
        id: crypto.randomUUID?.() ?? Math.random().toString(36).slice(2),
        file,
        url: file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : undefined,
      })),
    ]);
  };

  const removeFile = (id: string): void => {
    setFiles((prev) => {
      const t = prev.find((f) => f.id === id);
      if (t?.url) URL.revokeObjectURL(t.url);
      return prev.filter((f) => f.id !== id);
    });
  };

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    files.forEach((f) => f.url && URL.revokeObjectURL(f.url));
    setFiles([]);

    const userMsg = addUserMessage(text);
    addAssistantMessage();

    try {
      const bridge = api();
      if (!bridge) return;
      const unsubscribe = bridge.chat.onToken(handleLLMEvent);
      await bridge.chat.send({
        model: "",
        system: "",
        messages: [{ role: "user", content: userMsg.content }],
        max_tokens: 8192,
      });
      unsubscribe();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    }
  };

  const abort = async (): Promise<void> => {
    await api()?.chat.abort();
  };

  return (
    <div className="px-4 pb-4">
      <div className="mx-auto max-w-3xl">
        {files.length > 0 && (
          <div className="mb-2 flex gap-2 overflow-x-auto scrollbar-none">
            {files.map((f) => {
              const isImg = f.file.type.startsWith("image/");
              return (
                <Attachment key={f.id} size="sm" className="max-w-56">
                  <AttachmentMedia variant={isImg ? "image" : "icon"}>
                    {isImg && f.url ? (
                      <img src={f.url} alt={f.file.name} />
                    ) : (
                      <FileText />
                    )}
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle>{f.file.name}</AttachmentTitle>
                    <AttachmentDescription>
                      {formatSize(f.file.size)}
                    </AttachmentDescription>
                  </AttachmentContent>
                  <AttachmentActions>
                    <AttachmentAction
                      aria-label="Remove attachment"
                      onClick={() => removeFile(f.id)}
                    >
                      <X />
                    </AttachmentAction>
                  </AttachmentActions>
                </Attachment>
              );
            })}
          </div>
        )}

        <div className="rounded-xl border border-border bg-card transition-colors focus-within:border-foreground/25">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Type / for commands"
            rows={1}
            disabled={isStreaming}
            className="max-h-[200px] min-h-[24px] w-full resize-none bg-transparent px-3.5 pt-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
          />

          <div className="flex items-center gap-1 px-2 pb-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                stageFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              title="Add attachment"
              onClick={() => fileRef.current?.click()}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
            >
              <Plus className="size-4" />
            </button>
            <button
              type="button"
              className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
            >
              Auto <ChevronDown className="size-3" />
            </button>
            <button
              type="button"
              title="Dictate"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
            >
              <Mic className="size-4" />
            </button>

            <div className="flex-1" />

            <button
              type="button"
              className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
            >
              <span className="max-w-[16ch] truncate">{model || "Model"}</span>
              <ChevronDown className="size-3" />
            </button>

            {isStreaming ? (
              <button
                type="button"
                onClick={abort}
                title="Stop"
                className="flex size-7 items-center justify-center rounded-md bg-foreground text-background transition-opacity hover:opacity-90"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!input.trim()}
                title="Send"
                className={cn(
                  "flex size-7 items-center justify-center rounded-md bg-foreground text-background transition-opacity",
                  input.trim() ? "hover:opacity-90" : "opacity-30",
                )}
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
