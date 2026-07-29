import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  ArrowUp,
  ChevronDown,
  Check,
  Eye,
  EyeOff,
  Plus,
  Settings,
  Square,
  Gauge,
  History,
  Loader2,
  Sparkles,
  ListEnd,
  CornerDownLeft,
} from "lucide-react";
import { PermissionModeMenu, type PermissionMode } from "./PermissionModeMenu";
import { MicButton } from "./MicButton";
import { ContextMeter } from "./ContextMeter";
import { CheckpointPicker } from "./CheckpointPicker";
import {
  EffortSlider,
  effortLabel,
  effortTextClass,
  effortBgClass,
  type EffortValue,
} from "./EffortSlider";
import { ModalityBadges } from "@/components/providers/ModalityBadges";
import type { Modality } from "@/stores/providerStore";
import { StagedFileTile } from "@/components/FileCard";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useChatStore, type StagedAttachment } from "@/stores/chatStore";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

type StagedFile = StagedAttachment;

/** Stable empty array — a fresh `[]` per render would re-run every selector. */
const EMPTY_STAGED: StagedFile[] = [];

interface ProviderModelEntry {
  id: string;
  name: string;
  label?: string;
  contextLength?: number;
  maxInputTokens?: number;
  modalities?: string[];
  supportsEffort?: boolean;
  hidden?: boolean;
}

interface Provider {
  id: string;
  name: string;
  model?: string;
  contextLimit?: number;
  models?: ProviderModelEntry[];
  activeModelId?: string;
}

function activeModelOf(p: Provider): ProviderModelEntry | undefined {
  return p.models?.find((m) => m.id === p.activeModelId) ?? p.models?.[0];
}

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
  kind: "text" | "image" | "audio" | "video" | "file";
  text?: string;
  dataBase64?: string;
}

/** Binary attachments over this get replaced by a placeholder — base64 blows
 * them up ~1.37x and everything travels through IPC + the LLM API. */
const BINARY_CAP = 20 * 1024 * 1024;

/** Which input modality a staged file needs from the model. */
export function fileModality(
  file: File,
): "image" | "audio" | "video" | "file" {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  return "file";
}

async function buildAttachments(
  files: StagedFile[],
): Promise<AttachmentPayload[]> {
  const out: AttachmentPayload[] = [];
  for (const { file } of files) {
    try {
      const modality = fileModality(file);
      if (modality && file.size > BINARY_CAP) {
        out.push({
          name: file.name,
          mediaType: file.type,
          kind: "text",
          text: `[${modality} file too large to attach: ${file.name}]`,
        });
      } else if (modality === "image") {
        out.push({
          name: file.name,
          mediaType: file.type,
          kind: "image",
          dataBase64: await readAsBase64(file),
        });
      } else if (modality === "audio" || modality === "video") {
        out.push({
          name: file.name,
          mediaType: file.type,
          kind: modality,
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
        // Any other file: encode as base64 and send as a document attachment.
        // This covers pdf, docx, xlsx, zip, and everything else.
        const base64 =
          file.size <= BINARY_CAP ? await readAsBase64(file) : undefined;
        out.push({
          name: file.name,
          mediaType: file.type || "application/octet-stream",
          kind: "file",
          dataBase64: base64,
        });
      }
    } catch {
      out.push({
        name: file.name,
        mediaType: "application/octet-stream",
        kind: "text",
      });
    }
  }
  return out;
}

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/** UTF-8 safe text → base64. Chunked: String.fromCharCode(...bytes) on a
 * 200 000-character attachment overflows the argument limit. */
function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function MessageInput({
  flush = false,
  onOpenProviders,
}: {
  /** No horizontal padding — for the centered Home empty state. */
  flush?: boolean;
  onOpenProviders?: () => void;
} = {}): JSX.Element {
  // The composer text lives in the store PER CHAT (keyed by sessionId, or
  // "new:<space>" for a blank chat) — switching chats and coming back
  // restores what you were typing. setInput keeps the useState call shape.
  const draftKey = useChatStore(
    (s) => s.currentSessionId ?? `new:${s.space}`,
  );
  const input = useChatStore((s) => s.drafts[draftKey] ?? "");
  const setInput = useCallback(
    (v: string | ((prev: string) => string)): void => {
      const st = useChatStore.getState();
      const key = st.currentSessionId ?? `new:${st.space}`;
      const cur = st.drafts[key] ?? "";
      st.setDraft(key, typeof v === "function" ? v(cur) : v);
    },
    [],
  );
  // Staged attachments live in the store under the SAME per-chat key as the
  // text draft. As component state they outlived a chat switch, so files you
  // picked in one chat were still attached — and got sent — in the next.
  const files = useChatStore((s) => s.stagedFiles[draftKey] ?? EMPTY_STAGED);
  const setFiles = useCallback(
    (update: StagedFile[] | ((prev: StagedFile[]) => StagedFile[])): void => {
      const st = useChatStore.getState();
      st.setStagedFiles(st.currentSessionId ?? `new:${st.space}`, update);
    },
    [],
  );
  const [providers, setProviders] = useState<Provider[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [mode, setMode] = useState<PermissionMode>(
    () =>
      (localStorage.getItem("permission-mode") as PermissionMode | null) ||
      "default",
  );
  // Model-switch guard: set when the conversation exceeds ~80% of the target
  // model's context window — the banner offers to compact first.
  const [switchAsk, setSwitchAsk] = useState<{
    providerId: string;
    modelId: string;
    model: ProviderModelEntry;
    est: number;
    target: number;
  } | null>(null);
  // Transient info line under the composer (compaction result, modality note).
  const [notice, setNotice] = useState<string | null>(null);
  const [showHiddenModels, setShowHiddenModels] = useState(false);
  // "/" command menu: vendor slash commands + skills, loaded on first use.
  const [slashItems, setSlashItems] = useState<{
    commands: { name: string; description: string }[];
    skills: { name: string; description: string }[];
  } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  const usage = useChatStore((s) => s.usage);
  const composerDraft = useChatStore((s) => s.composerDraft);
  const setComposerDraft = useChatStore((s) => s.setComposerDraft);
  // Narrow subscriptions: a whole-store subscribe re-rendered the composer on
  // every streaming flush. Actions are stable references in zustand.
  const isStreaming = useChatStore((s) => s.isStreaming);
  const addUserMessage = useChatStore((s) => s.addUserMessage);
  const startStreaming = useChatStore((s) => s.startStreaming);
  const setError = useChatStore((s) => s.setError);

  // A Home suggestion chip (or anything else) can push text into the composer.
  useEffect(() => {
    if (composerDraft) {
      setInput(composerDraft);
      setComposerDraft("");
      taRef.current?.focus();
    }
  }, [composerDraft, setComposerDraft]);

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
  const activeModel = activeProvider ? activeModelOf(activeProvider) : undefined;
  const modelLabel =
    activeModel?.label ||
    activeModel?.name ||
    activeProvider?.model ||
    activeProvider?.name ||
    "Model";
  // Context meter budget comes from the ACTIVE MODEL's context length.
  const ctxWindow =
    activeModel?.contextLength ?? activeProvider?.contextLimit ?? 200000;
  const usedTokens = usage ? usage.input_tokens + usage.output_tokens : 0;
  const ctxPct = Math.min(100, Math.round((usedTokens / ctxWindow) * 100));

  const fmtTok = (n: number): string =>
    n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

  const applyModel = async (
    providerId: string,
    modelId: string,
    m?: ProviderModelEntry,
  ): Promise<void> => {
    await api()?.providers.setActiveModel(providerId, modelId);
    setActiveId(providerId);
    loadProviders();
    // The agent only sends what the model accepts — say so out loud when
    // switching to a model that will drop images from the context.
    const mods = m?.modalities ?? ["text"];
    if (!mods.includes("image")) {
      setNotice(
        `${m?.label || m?.name || "This model"} is text-only — images in the conversation won't be sent to it.`,
      );
    }
  };

  /** Switching models must respect what's already in the context: if the
   * conversation is larger than ~80% of the target model's window, offer to
   * compact it first. */
  const selectModel = async (
    p: Provider,
    m: ProviderModelEntry,
  ): Promise<void> => {
    const sessionId = useChatStore.getState().currentSessionId;
    const target = m.contextLength;
    if (target && sessionId) {
      try {
        const { tokens } = (await api()?.chat.estimate(sessionId)) ?? {
          tokens: 0,
        };
        if (tokens > target * 0.8) {
          setSwitchAsk({
            providerId: p.id,
            modelId: m.id,
            model: m,
            est: tokens,
            target,
          });
          return;
        }
      } catch {
        /* estimate is best-effort */
      }
    }
    await applyModel(p.id, m.id, m);
  };

  const compactAndSwitch = async (): Promise<void> => {
    const ask = switchAsk;
    if (!ask) return;
    setSwitchAsk(null);
    setNotice("Compacting context…");
    const res = await api()?.chat.compact(
      useChatStore.getState().currentSessionId,
    );
    await applyModel(ask.providerId, ask.modelId, ask.model);
    if (res?.ok && res.before != null && res.after != null) {
      setNotice(
        `Context compacted: ~${fmtTok(res.before)} → ~${fmtTok(res.after)} tokens.`,
      );
    } else {
      setNotice(
        res?.error === "Nothing to compact"
          ? "Nothing to compact yet — switched anyway."
          : `Compaction failed (${res?.error ?? "unknown"}) — switched anyway.`,
      );
    }
  };

  const toggleModelHidden = async (
    p: Provider,
    m: ProviderModelEntry,
  ): Promise<void> => {
    const models = (p.models ?? []).map((x) =>
      x.id === m.id ? { ...x, hidden: !x.hidden } : x,
    );
    await api()?.providers.update(p.id, { models } as never);
    loadProviders();
  };

  const pickMode = (id: PermissionMode): void => {
    setMode(id);
    localStorage.setItem("permission-mode", id);
  };

  // Approving a plan switches the mode from inside the plan dialog; without
  // this the selector would keep showing "Plan" after the model started work.
  useEffect(() => {
    const sync = (): void =>
      setMode(
        (localStorage.getItem("permission-mode") as PermissionMode | null) ||
          "default",
      );
    window.addEventListener("permission-mode-changed", sync);
    return () => window.removeEventListener("permission-mode-changed", sync);
  }, []);

  const stageFiles = (list: FileList | File[] | null): void => {
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

  const isHomeSpace = useChatStore((s) => s.space === "home");
  const space = useChatStore((s) => s.space);
  const currentSessionId = useChatStore((s) => s.currentSessionId);

  // Background sub-agents still running in this chat (Task run_in_background).
  const bgRunning = useChatStore((s) =>
    s.messages.reduce(
      (n, m) =>
        n +
        (m.toolCall?.subAgent?.background &&
        m.toolCall.subAgent.status === "running"
          ? 1
          : 0),
      0,
    ),
  );
  // Checkpoint picker (Code): a jump list of turns to rewind to.
  const hasUserTurns = useChatStore((s) =>
    s.messages.some((m) => m.role === "user"),
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  // Reasoning effort (Faster ↔ Smarter). A global composer preference, only
  // sent when the active model supports it. null = off (provider default).
  const [effort, setEffort] = useState<EffortValue>(() => {
    const v = localStorage.getItem("monet.effort");
    return v &&
      ["minimal", "low", "medium", "high", "xhigh", "max"].includes(v)
      ? (v as EffortValue)
      : null;
  });
  useEffect(() => {
    if (effort) localStorage.setItem("monet.effort", effort);
    else localStorage.removeItem("monet.effort");
  }, [effort]);

  // Files dropped anywhere over the chat window (ChatView catches the drop).
  const droppedFiles = useChatStore((s) => s.droppedFiles);
  useEffect(() => {
    if (droppedFiles && droppedFiles.length > 0) {
      stageFiles(droppedFiles);
      useChatStore.getState().setDroppedFiles(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedFiles]);

  /**
   * Hand the composer's text to the turn already running.
   *
   * Falls back to queueing when main says the session is idle — the run can
   * finish between the keypress and the IPC round trip, and losing what
   * someone just typed is the one outcome worth avoiding.
   */
  const injectNow = async (): Promise<void> => {
    const sid = useChatStore.getState().currentSessionId;
    const text = input.trim();
    if (!sid || !text) return;
    setInput("");
    const r = await api()?.chat.inject(sid, text);
    if (!r?.ok) useChatStore.getState().enqueueMessage(sid, text);
  };

  const removeFile = (id: string): void => {
    setFiles((prev) => {
      const t = prev.find((f) => f.id === id);
      if (t?.url) URL.revokeObjectURL(t.url);
      return prev.filter((f) => f.id !== id);
    });
  };

  // "/" opens the menu ANYWHERE in the prompt: track the caret and look for a
  // slash-token right before it (slash at start of input or after whitespace,
  // followed by name characters only). A space closes it (arguments begin).
  const [caret, setCaret] = useState(0);
  const slashTok = useMemo(() => {
    const upto = input.slice(0, caret);
    const m = /(?:^|\s)\/([A-Za-z0-9_:./-]*)$/.exec(upto);
    if (!m) return null;
    return { query: m[1], start: caret - m[1].length - 1 };
  }, [input, caret]);
  const slashQuery = slashTok?.query ?? null;

  useEffect(() => {
    if (slashQuery == null) {
      setSlashDismissed(false);
      return;
    }
    setSlashIndex(0);
    if (!slashItems) {
      api()
        ?.commands.list()
        .then((r) =>
          setSlashItems({
            // App-level commands run in the composer, not on the model.
            commands: [
              {
                name: "compact",
                description: "Compact this chat's context (summarize old turns)",
              },
              {
                name: "clear",
                description: "Clear this chat's conversation history",
              },
              {
                name: "rename",
                description: "Rename this chat: /rename New title",
              },
              {
                name: "create-routine",
                description:
                  "Describe a task and a schedule; the agent builds the routine",
              },
              ...r.commands,
            ],
            skills: r.skills,
          }),
        )
        .catch(() => setSlashItems({ commands: [], skills: [] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashQuery]);

  const slashFlat = useMemo(() => {
    if (slashQuery == null || !slashItems) return [];
    const q = slashQuery.toLowerCase();
    const match = (c: { name: string }): boolean =>
      c.name.toLowerCase().includes(q);
    return [
      ...slashItems.commands
        .filter(match)
        .map((c) => ({ ...c, section: "Commands" as const })),
      ...slashItems.skills
        .filter(match)
        .map((c) => ({ ...c, section: "Skills" as const })),
    ];
  }, [slashQuery, slashItems]);

  const slashOpen =
    slashQuery != null && !slashDismissed && slashFlat.length > 0;

  const pickSlash = (name: string): void => {
    if (!slashTok) return;
    const before = input.slice(0, slashTok.start);
    const after = input.slice(caret);
    setInput(`${before}/${name} ${after}`);
    const pos = before.length + name.length + 2;
    requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  /** App-level commands handled in the composer, never sent to the model. */
  const runLocalCommand = async (
    cmd: string,
    arg: string,
  ): Promise<void> => {
    const store = useChatStore.getState();
    const sid = store.currentSessionId;
    if (cmd === "compact") {
      setNotice("Compacting context…");
      const r = await api()?.chat.compact(sid);
      setNotice(
        r?.ok && r.before != null && r.after != null
          ? `Context compacted: ~${fmtTok(r.before)} → ~${fmtTok(r.after)} tokens.`
          : (r?.error ?? "Nothing to compact yet."),
      );
      return;
    }
    if (cmd === "clear") {
      if (sid) void api()?.chat.reset(sid);
      store.clearMessages();
      setNotice("Conversation history cleared.");
      return;
    }
    if (cmd === "rename") {
      if (!sid) {
        setNotice("Nothing to rename yet — send a message first.");
        return;
      }
      const title = arg.slice(0, 60);
      await api()?.sessions.updateTitle(sid, title);
      store.bumpSessions();
      setNotice(title ? `Renamed to “${title}”.` : "Chat title regenerated.");
    }
  };

  const send = async (): Promise<void> => {
    let text = input.trim();
    if (!text) return;

    // Intercept app-level slash commands before anything reaches the model.
    const local = /^\/(compact|clear|rename)(?:\s+([\s\S]*))?$/.exec(text);
    if (local) {
      setInput("");
      void runLocalCommand(local[1], local[2]?.trim() ?? "");
      return;
    }

    // /create-routine expands into a plain instruction rather than being handled
    // here: turning "every weekday at 9" into cron is the model's job, and it
    // has CreateRoutine for the rest. Sending the raw "/create-routine …" text
    // would just make the model guess what the slash meant.
    const routine = /^\/create-routine(?:\s+([\s\S]*))?$/.exec(text);
    if (routine) {
      const wish = routine[1]?.trim();
      text = wish
        ? `Create a routine for this: ${wish}\n\nWork out the schedule and the connectors it needs, show me what you're about to create, and use the CreateRoutine tool.`
        : "I want to create a routine. Ask me what it should do and when, then use the CreateRoutine tool.";
    }

    // A model that can't consume an attachment inline no longer BLOCKS the
    // send: the backend saves such files into the chat's sandbox / workspace
    // and hands the model the path, so it can still get at the data (OCR an
    // image, read a PDF with its file tools). Just tell the user what will
    // happen instead of refusing.
    const mods = activeModel?.modalities ?? ["text"];
    const unsupported = files
      .map((f) => fileModality(f.file))
      .find((k) => k && !mods.includes(k));
    if (unsupported) {
      setNotice(
        `${modelLabel} can't read ${unsupported} directly — it'll be saved to the workspace so the model can open it with its tools.`,
      );
    }
    const inputBudget =
      activeModel?.maxInputTokens ?? activeModel?.contextLength;
    if (inputBudget) {
      const attachedChars = files.reduce(
        (sum, f) => (isTextFile(f.file) ? sum + Math.min(f.file.size, 200000) : sum),
        0,
      );
      const estIn = Math.ceil((text.length + attachedChars) / 4);
      if (estIn > inputBudget) {
        setError(
          `The message is ~${fmtTok(estIn)} tokens — over ${modelLabel}'s ~${fmtTok(inputBudget)} input budget. Trim it or switch models.`,
        );
        return;
      }
    }

    const staged = files;
    setInput("");
    setFiles([]);

    const bridge = api();
    const store = useChatStore.getState();
    // NOTE: no Podman readiness gate here. The Home banner (ChatView) already
    // warns when it isn't ready, and RunPython provisions it lazily and surfaces
    // any error in the tool result. Gating the send here silently dropped the
    // message (input was already cleared) and its heavy check wedged the VM.
    const attachments = staged.length
      ? await buildAttachments(staged)
      : undefined;
    staged.forEach((f) => f.url && URL.revokeObjectURL(f.url));

    const incognito = store.incognito;
    let sessionId = store.currentSessionId;
    if (incognito) {
      // Transient in-memory session — never persisted, never in Recents. Keep
      // a stable id so the agent's multi-turn conversation map still works.
      if (!sessionId) {
        sessionId = `incognito-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
        store.setCurrentSessionId(sessionId);
      }
    } else if (!sessionId && bridge) {
      try {
        const s = (await bridge.sessions.create(
          text.slice(0, 60),
          store.space,
        )) as { id: string } | undefined;
        if (s?.id) {
          sessionId = s.id;
          store.setCurrentSessionId(s.id);
          store.bumpSessions();
          // A new chat adopts the current working directory as its own.
          void bridge.workspace
            .get()
            .then((ws) => {
              if (ws) void bridge.sessions.setWorkspace(s.id, ws);
            })
            .catch(() => {});
        }
      } catch {
        /* offline */
      }
    }

    const seed = store.messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    // Show what was attached on the user bubble (image thumbnails come from
    // the already-encoded base64; other kinds render as chips).
    const displayAttachments = attachments?.map((a) => ({
      name: a.name,
      mediaType: a.mediaType,
      kind: a.kind,
      dataUrl:
        a.kind === "image" && a.dataBase64
          ? `data:${a.mediaType || "image/png"};base64,${a.dataBase64}`
          : undefined,
      path: undefined as string | undefined,
    }));
    // Persist binaries as artifacts on disk so previews survive chat
    // switches/reloads and files can be opened later (incognito excluded).
    if (bridge && sessionId && !incognito && attachments && displayAttachments) {
      await Promise.all(
        attachments.map(async (a, i) => {
          // Text attachments were skipped here, so they had no file behind
          // them: they could not be opened from the chat later, and a retry
          // had nothing to re-read. They are small — save them too.
          const data =
            a.dataBase64 ?? (a.text != null ? textToBase64(a.text) : undefined);
          if (!data) return;
          try {
            const r = await bridge.artifacts.save({
              sessionId,
              name: a.name,
              dataBase64: data,
            });
            if (r.ok && r.path) displayAttachments[i].path = r.path;
          } catch {
            /* preview-only */
          }
        }),
      );
    }
    addUserMessage(text, displayAttachments);
    startStreaming();

    try {
      if (!bridge) return;
      // Events stream back through the app-level onToken listener (routed by
      // sessionId), so the run keeps updating even if the user switches chats.
      // Persistence happens in the chatStore on message_stop — saving here
      // after the invoke resolves raced the last chat:token events (the reply
      // travels a different IPC path) and clipped the tail of long replies.
      // Home only knows approve/skip — a Code-only mode saved in prefs
      // (plan/acceptEdits/auto) degrades to manual approval there.
      const effectiveMode =
        store.space === "home" && mode !== "bypassPermissions"
          ? "default"
          : mode;
      await bridge.chat.send({
        sessionId,
        message: text,
        seed,
        mode: effectiveMode,
        space: store.space,
        effort: activeModel?.supportsEffort ? (effort ?? undefined) : undefined,
        attachments,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    }
  };

  const abort = async (): Promise<void> => {
    // Stop only the current chat — other chats keep running in the background.
    await api()?.chat.abort(useChatStore.getState().currentSessionId);
  };

  const pillBtn =
    "flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]";

  return (
    <div className="">
      {pickerOpen && (
        <CheckpointPicker onClose={() => setPickerOpen(false)} />
      )}
      {/* flush: the centered Home empty state has no px-4 around its content,
          so the composer drops it too. Everywhere else (active chats in BOTH
          spaces) the transcript column has px-4 — keep the composer aligned. */}
      <div
        className={cn(
          "relative mx-auto w-full max-w-3xl",
          flush ? "px-0" : "px-4",
        )}
      >
        {slashOpen && (
          <div
            className={cn(
              "absolute bottom-full z-50 mb-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-lg",
              flush ? "left-0 right-0" : "left-4 right-4",
            )}
          >
            {(["Commands", "Skills"] as const).map((section) => {
              const items = slashFlat.filter((i) => i.section === section);
              if (items.length === 0) return null;
              return (
                <div key={section}>
                  <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {section}
                  </div>
                  {items.map((item) => {
                    const idx = slashFlat.indexOf(item);
                    return (
                      <button
                        key={`${section}-${item.name}`}
                        type="button"
                        onMouseEnter={() => setSlashIndex(idx)}
                        onClick={() => pickSlash(item.name)}
                        className={cn(
                          "flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left transition-colors",
                          idx === slashIndex &&
                            "bg-black/6 dark:bg-white/8",
                        )}
                      >
                        <span className="shrink-0 font-mono text-[13px]">
                          /{item.name}
                        </span>
                        {item.description && (
                          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                            {item.description}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
        {switchAsk && (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px]">
            <span className="min-w-0 flex-1">
              The conversation is ~{fmtTok(switchAsk.est)} tokens —{" "}
              {switchAsk.model.label || switchAsk.model.name} fits{" "}
              {fmtTok(switchAsk.target)}. Compact the context first?
            </span>
            <button
              type="button"
              onClick={() => void compactAndSwitch()}
              className="rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90"
            >
              Compact & switch
            </button>
            <button
              type="button"
              onClick={() => {
                const ask = switchAsk;
                setSwitchAsk(null);
                if (ask) void applyModel(ask.providerId, ask.modelId, ask.model);
              }}
              className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Switch anyway
            </button>
            <button
              type="button"
              onClick={() => setSwitchAsk(null)}
              className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        )}
        {notice && (
          <div className="mb-2 rounded-lg bg-black/4 px-3 py-1.5 text-[12px] text-muted-foreground dark:bg-white/6">
            {notice}
          </div>
        )}
        
        {files.length > 0 && (
          // Same tile as the Content panel, so a file looks the same before
          // you send it and after. auto-fill keeps the row count sensible from
          // a narrow Home column to a wide window.
          <div className="mb-2 grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
            {files.map((f) => (
              <StagedFileTile
                key={f.id}
                id={f.id}
                file={f.file}
                previewUrl={f.url}
                onRemove={() => removeFile(f.id)}
              />
            ))}
          </div>
        )}
        
        <div className="glass-panel p-3 rounded-2xl border border-border bg-card transition-colors focus-within:border-foreground/25">
          
          <div className="flex gap-2.5 w-full items-end">
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setCaret(e.target.selectionStart ?? e.target.value.length);
              }}
              onSelect={(e) =>
                setCaret(e.currentTarget.selectionStart ?? 0)
              }
              onKeyDown={(e) => {
                // "/" menu navigation takes priority while it's open.
                if (slashOpen) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashIndex((i) => (i + 1) % slashFlat.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashIndex(
                      (i) => (i - 1 + slashFlat.length) % slashFlat.length,
                    );
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    pickSlash(slashFlat[slashIndex]?.name ?? slashQuery ?? "");
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSlashDismissed(true);
                    return;
                  }
                }
                // Ctrl/Cmd+S while streaming: hand the text to the RUNNING
                // turn instead of queueing it behind the whole reply. The
                // point of typing mid-run is usually "stop, not like that".
                if (
                  e.key === "s" &&
                  (e.ctrlKey || e.metaKey) &&
                  isStreaming &&
                  input.trim()
                ) {
                  e.preventDefault();
                  void injectNow();
                  return;
                }
                // Enter inserts a newline; Ctrl/Cmd+Enter sends or queues.
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  if (isStreaming) {
                    const sid = useChatStore.getState().currentSessionId;
                    const text = input.trim();
                    if (sid && text) {
                      useChatStore.getState().enqueueMessage(sid, text);
                      setInput("");
                    }
                  } else {
                    send();
                  }
                }
              }}
              placeholder="Type / for commands"
              rows={1}
              className="pt-1 pl-1 max-h-50 min-h-7 w-full resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
            />
  
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
            {isStreaming ? (
              <>
                <button
                  type="button"
                  onClick={() => void injectNow()}
                  disabled={!input.trim()}
                  title="Send into the running turn (Ctrl+S) — the model sees it before its next step"
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md transition-opacity",
                    input.trim()
                      ? "bg-foreground text-background hover:opacity-90"
                      : "opacity-30",
                  )}
                >
                  <CornerDownLeft className="size-4" />
                </button>
                <div className="w-1" />
                <button
                  type="button"
                  onClick={() => {
                    const sid = useChatStore.getState().currentSessionId;
                    const text = input.trim();
                    if (!sid || !text) return;
                    useChatStore.getState().enqueueMessage(sid, text);
                    setInput("");
                  }}
                  disabled={!input.trim()}
                  title="Queue message (send after generation)"
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md transition-opacity",
                    input.trim()
                      ? "bg-foreground text-background hover:opacity-90"
                      : "opacity-30",
                  )}
                >
                  <ListEnd className="size-4" />
                </button>
                <div className="w-1" />
                <button
                  type="button"
                  onClick={abort}
                  title="Stop"
                  className="flex size-7 items-center justify-center rounded-md bg-foreground text-background transition-opacity hover:opacity-90"
                >
                  <Square className="size-3.5 fill-current" />
                </button>
              </>
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

          {/* Controls inside the composer card */}
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                title="Attach files"
                onClick={() => fileRef.current?.click()}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/6 hover:text-foreground dark:hover:bg-white/8"
              >
                <Plus className="size-4" />
              </button>
              <PermissionModeMenu
                mode={mode}
                onChange={pickMode}
                home={isHomeSpace}
              />
              <MicButton
                onText={(t) =>
                  setInput((prev) => (prev ? prev.trimEnd() + " " : "") + t)
                }
              />
            </div>

            <div className="flex min-w-0 items-center gap-1.5">

              {bgRunning > 0 && (
                <span
                  className={cn(
                    pillBtn,
                    "cursor-default text-amber-600 dark:text-amber-400",
                  )}
                  title={`${bgRunning} sub-agent${bgRunning > 1 ? "s" : ""} running in the background`}
                >
                  <Loader2 className="size-3 animate-spin" />
                  {bgRunning}
                </span>
              )}

              {!isHomeSpace && hasUserTurns && (
                <button
                  type="button"
                  title="Rewind to a checkpoint"
                  onClick={() => setPickerOpen(true)}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/6 hover:text-foreground dark:hover:bg-white/8"
                >
                  <History className="size-4" />
                </button>
              )}

              {activeModel && (
                <ContextMeter
                  sessionId={currentSessionId ?? null}
                  space={space}
                  usedTokens={usedTokens}
                  ctxWindow={ctxWindow}
                  className={pillBtn}
                />
              )}

              {activeModel?.supportsEffort && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(pillBtn, effortBgClass(effort))}
                      title="Reasoning effort (Faster ↔ Smarter)"
                    >
                      <Sparkles className={cn("size-3", effortTextClass(effort))} />
                      <span className={cn("font-medium", effortTextClass(effort))}>
                        {effortLabel(effort)}
                      </span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="end" className="w-56">
                    <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
                    <EffortSlider value={effort} onChange={setEffort} />
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              {/* Model / provider */}
              <DropdownMenu onOpenChange={(open) => { if (open) loadProviders(); }}>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={pillBtn}>
                    <span className="max-w-[18ch] truncate">{modelLabel}</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="end" className="w-80">
                  {providers.length === 0 && (
                    <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
                      No providers — add one in Settings.
                    </div>
                  )}
                  {providers.map((p) => {
                    const models: ProviderModelEntry[] = p.models?.length
                      ? p.models
                      : p.model
                        ? [{ id: "__flat", name: p.model }]
                        : [];
                    const visible = models.filter(
                      (m) => showHiddenModels || !m.hidden,
                    );
                    if (visible.length === 0) return null;
                    const currentId = activeModelOf(p)?.id;
                    return (
                      <div key={p.id}>
                        <DropdownMenuLabel className="text-xs text-muted-foreground py-0.5 px-2 bg-accent w-fit rounded-full my-0.5">
                          {p.name}
                        </DropdownMenuLabel>
                        {visible.map((m) => (
                          <DropdownMenuItem
                            key={m.id}
                            className={cn("group/model", m.hidden && "opacity-60")}
                            onClick={() =>
                              m.id === "__flat"
                                ? void api()
                                    ?.providers.setActive(p.id)
                                    .then(() => {
                                      setActiveId(p.id);
                                      loadProviders();
                                    })
                                : void selectModel(p, m)
                            }
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate">
                                  {m.label || m.name}
                                </span>
                                <ModalityBadges
                                  modalities={m.modalities as Modality[]}
                                />
                              </div>
                              <div className="truncate text-xs text-muted-foreground">
                                {m.label ? `${m.name} · ` : ""}
                                {m.contextLength
                                  ? `${fmtTok(m.contextLength)} ctx`
                                  : "ctx —"}
                              </div>
                            </div>
                            {m.id !== "__flat" && (
                              <button
                                type="button"
                                title={
                                  m.hidden
                                    ? "Show in this list"
                                    : "Hide from this list"
                                }
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void toggleModelHidden(p, m);
                                }}
                                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:text-foreground group-hover/model:opacity-100"
                              >
                                {m.hidden ? (
                                  <EyeOff className="size-3" />
                                ) : (
                                  <Eye className="size-3" />
                                )}
                              </button>
                            )}
                            {p.id === activeId && m.id === currentId && (
                              <Check className="size-4 shrink-0" />
                            )}
                          </DropdownMenuItem>
                        ))}
                      </div>
                    );
                  })}
                  <DropdownMenuSeparator />
                  {(() => {
                    const hiddenCount = providers.reduce(
                      (n, p) =>
                        n + (p.models?.filter((m) => m.hidden).length ?? 0),
                      0,
                    );
                    return hiddenCount > 0 ? (
                      <button
                        type="button"
                        onClick={() => setShowHiddenModels((v) => !v)}
                        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/6"
                      >
                        {showHiddenModels ? (
                          <EyeOff className="size-3" />
                        ) : (
                          <Eye className="size-3" />
                        )}
                        {showHiddenModels
                          ? "Hide hidden models"
                          : `Show hidden (${hiddenCount})`}
                      </button>
                    ) : null;
                  })()}
                  {onOpenProviders && (
                    <button
                      type="button"
                      onClick={onOpenProviders}
                      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/6"
                    >
                      <Settings className="size-3" />
                      Providers
                    </button>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
