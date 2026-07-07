import { useState, useRef, useEffect } from "react";
import {
  ArrowUp,
  ChevronDown,
  Check,
  Mic,
  Plus,
  Square,
  X,
  FileText,
  Zap,
  ListChecks,
  Minimize2,
  Gauge,
} from "lucide-react";
import {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
} from "@/components/ui/attachment";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useChatStore } from "@/stores/chatStore";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

interface StagedFile {
  id: string;
  file: File;
  url?: string;
}

interface Provider {
  id: string;
  name: string;
  model?: string;
  contextWindow?: number;
}

const MODES = [
  { id: "auto", label: "Auto", icon: Zap, hint: "Balanced default" },
  { id: "plan", label: "Plan", icon: ListChecks, hint: "Plan before acting" },
  { id: "concise", label: "Concise", icon: Minimize2, hint: "Short answers" },
] as const;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

const TEXT_EXT =
  /\.(txt|md|markdown|json|jsonc|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|css|scss|less|html|xml|svg|yaml|yml|toml|ini|env|sh|bash|zsh|ps1|sql|csv|tsv|log|gitignore|dockerfile|makefile)$/i;

function isTextFile(file: File): boolean {
  return (
    file.type.startsWith("text/") ||
    file.type === "application/json" ||
    file.type === "application/xml" ||
    !file.type ||
    TEXT_EXT.test(file.name)
  );
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? "").split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

interface AttachmentPayload {
  name: string;
  mediaType: string;
  kind: "text" | "image";
  text?: string;
  dataBase64?: string;
}

async function buildAttachments(files: StagedFile[]): Promise<AttachmentPayload[]> {
  const out: AttachmentPayload[] = [];
  for (const { file } of files) {
    try {
      if (file.type.startsWith("image/")) {
        out.push({
          name: file.name,
          mediaType: file.type,
          kind: "image",
          dataBase64: await readAsBase64(file),
        });
      } else if (isTextFile(file)) {
        const text = await readAsText(file);
        out.push({
          name: file.name,
          mediaType: file.type || "text/plain",
          kind: "text",
          text: text.slice(0, 200000),
        });
      } else {
        out.push({
          name: file.name,
          mediaType: file.type || "application/octet-stream",
          kind: "text",
        });
      }
    } catch {
      out.push({ name: file.name, mediaType: "application/octet-stream", kind: "text" });
    }
  }
  return out;
}

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

export function MessageInput(): JSX.Element {
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [mode, setMode] = useState<string>(
    () => localStorage.getItem("chat-mode") || "auto",
  );
  const [listening, setListening] = useState(false);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);

  const usage = useChatStore((s) => s.usage);
  const { addUserMessage, addAssistantMessage, handleLLMEvent, setError, isStreaming } =
    useChatStore();

  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    }
  }, [input]);

  const loadProviders = (): void => {
    const bridge = api();
    if (!bridge) return;
    Promise.all([bridge.providers.list(), bridge.providers.getActive()])
      .then(([list, active]) => {
        setProviders((list as Provider[]) ?? []);
        setActiveId((active as Provider | undefined)?.id ?? "");
      })
      .catch(() => {});
  };
  useEffect(loadProviders, []);

  const activeProvider = providers.find((p) => p.id === activeId);
  const modelLabel = activeProvider?.model || activeProvider?.name || "Model";
  const ctxWindow = activeProvider?.contextWindow ?? 200000;
  const usedTokens = usage ? usage.input_tokens + usage.output_tokens : 0;
  const ctxPct = Math.min(100, Math.round((usedTokens / ctxWindow) * 100));

  const selectProvider = async (id: string): Promise<void> => {
    await api()?.providers.setActive(id);
    setActiveId(id);
  };

  const pickMode = (id: string): void => {
    setMode(id);
    localStorage.setItem("chat-mode", id);
  };

  const toggleMic = (): void => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const SR =
      (window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: unknown })
        .webkitSpeechRecognition;
    if (!SR) {
      setError("Speech recognition isn't available in this build.");
      return;
    }
    const rec = new (SR as new () => {
      lang: string;
      interimResults: boolean;
      continuous: boolean;
      onresult: (e: unknown) => void;
      onend: () => void;
      onerror: () => void;
      start: () => void;
      stop: () => void;
    })();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    const baseText = input ? input + " " : "";
    rec.onresult = (e: unknown) => {
      const ev = e as {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      };
      let text = "";
      for (let i = 0; i < ev.results.length; i++) {
        text += ev.results[i][0].transcript;
      }
      setInput((baseText + text).trimStart());
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  };

  const stageFiles = (list: FileList | null): void => {
    if (!list) return;
    setFiles((prev) => [
      ...prev,
      ...Array.from(list).map((file) => ({
        id: crypto.randomUUID?.() ?? Math.random().toString(36).slice(2),
        file,
        url: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
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
    const staged = files;
    setInput("");
    setFiles([]);

    const bridge = api();
    const store = useChatStore.getState();
    const attachments = staged.length
      ? await buildAttachments(staged)
      : undefined;
    staged.forEach((f) => f.url && URL.revokeObjectURL(f.url));

    let sessionId = store.currentSessionId;
    if (!sessionId && bridge) {
      try {
        const s = (await bridge.sessions.create(text.slice(0, 60))) as
          | { id: string }
          | undefined;
        if (s?.id) {
          sessionId = s.id;
          store.setCurrentSessionId(s.id);
          store.bumpSessions();
        }
      } catch {
        /* offline */
      }
    }

    const seed = store.messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    addUserMessage(text);
    addAssistantMessage();

    try {
      if (!bridge) return;
      const unsubscribe = bridge.chat.onToken(handleLLMEvent);
      await bridge.chat.send({ sessionId, message: text, seed, mode, attachments });
      unsubscribe();

      if (sessionId) {
        const msgs = useChatStore.getState().messages;
        const title =
          msgs.find((m) => m.role === "user")?.content?.slice(0, 60) ??
          "New Session";
        await bridge.sessions.save({ id: sessionId, title, messages: msgs });
        useChatStore.getState().bumpSessions();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    }
  };

  const abort = async (): Promise<void> => {
    await api()?.chat.abort();
  };

  const currentMode = MODES.find((m) => m.id === mode) ?? MODES[0];
  const pillBtn =
    "flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]";

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
                    {isImg && f.url ? <img src={f.url} alt={f.file.name} /> : <FileText />}
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle>{f.file.name}</AttachmentTitle>
                    <AttachmentDescription>{formatSize(f.file.size)}</AttachmentDescription>
                  </AttachmentContent>
                  <AttachmentActions>
                    <AttachmentAction aria-label="Remove attachment" onClick={() => removeFile(f.id)}>
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
              title="Attach files"
              onClick={() => fileRef.current?.click()}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
            >
              <Plus className="size-4" />
            </button>

            {/* Mode / effort */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className={pillBtn}>
                  <currentMode.icon className="size-3.5" />
                  {currentMode.label}
                  <ChevronDown className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-52">
                <DropdownMenuLabel>Mode</DropdownMenuLabel>
                {MODES.map((m) => (
                  <DropdownMenuItem key={m.id} onClick={() => pickMode(m.id)}>
                    <m.icon />
                    <span className="flex-1">{m.label}</span>
                    {mode === m.id && <Check className="size-4" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <button
              type="button"
              title={listening ? "Stop dictation" : "Dictate"}
              onClick={toggleMic}
              className={cn(
                "flex size-7 items-center justify-center rounded-md transition-colors",
                listening
                  ? "bg-destructive/15 text-destructive"
                  : "text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]",
              )}
            >
              <Mic className="size-4" />
            </button>

            <div className="flex-1" />

            {usedTokens > 0 && (
              <span
                className="flex items-center gap-1 px-1.5 text-[11px] text-muted-foreground"
                title={`${usedTokens.toLocaleString()} tokens of ~${ctxWindow.toLocaleString()} context`}
              >
                <Gauge className="size-3" />
                {formatTokens(usedTokens)} · {ctxPct}%
              </span>
            )}

            {/* Model / provider */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className={pillBtn}>
                  <span className="max-w-[18ch] truncate">{modelLabel}</span>
                  <ChevronDown className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end" className="w-64">
                <DropdownMenuLabel>Provider</DropdownMenuLabel>
                {providers.length === 0 && (
                  <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
                    No providers — add one in Settings.
                  </div>
                )}
                {providers.map((p) => (
                  <DropdownMenuItem key={p.id} onClick={() => selectProvider(p.id)}>
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{p.name}</div>
                      {p.model && (
                        <div className="truncate text-xs text-muted-foreground">
                          {p.model}
                        </div>
                      )}
                    </div>
                    {p.id === activeId && <Check className="size-4" />}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={loadProviders}>Refresh</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

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
