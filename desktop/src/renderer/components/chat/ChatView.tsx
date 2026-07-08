import { useEffect, useState, useMemo } from "react";
import { useChatStore } from "@/stores/chatStore";
import { MarkdownViewer } from "./MarkdownViewer";
import { ToolCallBubble } from "./ToolCallBubble";
import { MessageInput } from "./MessageInput";
import { PermissionDialog } from "./PermissionDialog";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "@/components/ui/message-scroller";
import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Shimmer } from "@/components/ui/shimmer";
import { StatsDashboard } from "@/components/StatsDashboard";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { cn } from "@/lib/utils";
import greetings from "@/data/greetings.json";
import type { ElectronAPI, PermissionRequest } from "@/types/electron";
import type { ChatMessage, ToolCall } from "@/types/chat";

type TranscriptMode = "normal" | "thinking" | "verbose" | "summary";

function WorkingRow(): JSX.Element {
  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="ghost">
          <BubbleContent>
            <Shimmer>Working…</Shimmer>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

function MessageRow({
  msg,
  mode,
}: {
  msg: ChatMessage;
  mode?: TranscriptMode;
}): JSX.Element {
  if (msg.role === "tool" && msg.toolCall) {
    return <ToolCallBubble toolCall={msg.toolCall} mode={mode} />;
  }

  const isUser = msg.role === "user";

  return (
    <Message align={isUser ? "end" : "start"}>
      <MessageContent>
        {isUser ? (
          <Bubble variant="secondary" align="end">
            <BubbleContent className="whitespace-pre-wrap dark:bg-white/[0.08]">
              {msg.content}
            </BubbleContent>
          </Bubble>
        ) : (
          <Bubble variant="ghost">
            <BubbleContent className={cn(msg.isError && "text-destructive")}>
              {msg.content ? <MarkdownViewer content={msg.content} /> : null}
            </BubbleContent>
          </Bubble>
        )}
      </MessageContent>
    </Message>
  );
}

type GroupedItem =
  ChatMessage | { type: "tool-group"; id: string; calls: ToolCall[] };

/** In Normal mode, consecutive tool messages become a single group card. */
function groupMessages(
  msgs: ChatMessage[],
  mode: TranscriptMode,
): GroupedItem[] {
  if (mode !== "normal") return msgs;

  const out: GroupedItem[] = [];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (m.role === "tool" && m.toolCall) {
      const group: ToolCall[] = [m.toolCall];
      let j = i + 1;
      while (j < msgs.length && msgs[j].role === "tool" && msgs[j].toolCall) {
        group.push(msgs[j].toolCall!);
        j++;
      }
      out.push({ type: "tool-group", id: `tg-${i}`, calls: group });
      i = j;
    } else {
      out.push(m);
      i++;
    }
  }
  return out;
}

function pickGreeting(isFirstRun: boolean): {
  title: string;
  subtitle: string;
} {
  const hour = new Date().getHours();
  let timeKey: keyof typeof greetings = "anytime";
  if (hour >= 5 && hour < 12) timeKey = "morning";
  else if (hour >= 12 && hour < 17) timeKey = "afternoon";
  else if (hour >= 17 && hour < 22) timeKey = "evening";
  else timeKey = "night";

  const name = localStorage.getItem("user-name") || "friend";

  let title: string;
  if (isFirstRun) {
    const pool = greetings.first_run;
    title = pool[Math.floor(Math.random() * pool.length)];
  } else {
    const pool = [...greetings.anytime, ...(greetings[timeKey] || [])];
    title = pool[Math.floor(Math.random() * pool.length)];
  }
  title = title.replace("<name>", name);

  const tamagotchi =
    greetings.tamagotchi[
      Math.floor(Math.random() * greetings.tamagotchi.length)
    ];

  return { title, subtitle: tamagotchi };
}
export function ChatView({
  transcriptMode = "normal",
  sessionTitle,
}: {
  transcriptMode?: TranscriptMode;
  sessionTitle?: string;
}): JSX.Element {
  const messages = useChatStore((s) => s.messages);
  const error = useChatStore((s) => s.error);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const isEmpty = messages.length === 0 && !error;

  const isFirstRun = useMemo(() => {
    const flag = localStorage.getItem("monet-first-run");
    if (!flag) {
      localStorage.setItem("monet-first-run", "done");
      return true;
    }
    return false;
  }, []);

  const greeting = useMemo(() => pickGreeting(isFirstRun), [isFirstRun]);

  const grouped = groupMessages(messages, transcriptMode);

  const last = messages[messages.length - 1];
  const activeText =
    last?.role === "assistant" && last.isStreaming && !!last.content;
  const showWorking = isStreaming && !activeText;

  return (
    <div className="flex h-full flex-col">
      {isEmpty ? (
        <div className="flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-3xl px-4 pt-12 text-left">
            <h2 className="font-[Copernicus] text-2xl font-medium text-foreground">
              {greeting.title}
            </h2>
            <p className="mt-2 mb-4 max-w-md text-base leading-relaxed text-muted-foreground">
              {greeting.subtitle}
            </p>
          </div>
          <StatsDashboard />
        </div>
      ) : (
        <>
          {sessionTitle && (
            <div className="px-4 pt-3 text-[13px] font-medium text-muted-foreground">
              {sessionTitle}
            </div>
          )}
          <MessageScrollerProvider autoScroll defaultScrollPosition="end">
            <MessageScroller className="flex-1">
              <MessageScrollerViewport>
                <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-2 px-4 py-4">
                  {grouped.map((item, i) => {
                    if ("type" in item && item.type === "tool-group") {
                      return (
                        <MessageScrollerItem
                          key={item.id}
                          messageId={item.id}
                          scrollAnchor={
                            !showWorking && i === grouped.length - 1
                          }
                        >
                          <ToolCallBubble
                            toolCall={item.calls[0]}
                            groupMembers={item.calls.slice(1)}
                            mode={transcriptMode}
                          />
                        </MessageScrollerItem>
                      );
                    }
                    return (
                      <MessageScrollerItem
                        key={item.id}
                        messageId={item.id}
                        scrollAnchor={!showWorking && i === grouped.length - 1}
                      >
                        <MessageRow
                          msg={item as ChatMessage}
                          mode={transcriptMode}
                        />
                      </MessageScrollerItem>
                    );
                  })}

                  {showWorking && (
                    <MessageScrollerItem messageId="__working" scrollAnchor>
                      <WorkingRow />
                    </MessageScrollerItem>
                  )}

                  {error && (
                    <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                      {error}
                    </div>
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton direction="end" />
            </MessageScroller>
          </MessageScrollerProvider>
        </>
      )}

      <div className="mx-auto w-full max-w-3xl px-4 pb-1">
        <WorkspacePicker />
      </div>
      <MessageInput />
    </div>
  );
}

export function PermissionHost(): JSX.Element | null {
  const [request, setRequest] = useState<PermissionRequest | null>(null);

  useEffect(() => {
    const bridge = (window as unknown as { electronAPI?: ElectronAPI })
      .electronAPI;
    if (!bridge?.permissions) return;
    return bridge.permissions.onRequest((req: PermissionRequest) =>
      setRequest(req),
    );
  }, []);

  if (!request) return null;

  return (
    <PermissionDialog
      key={request.id}
      request={request}
      onDecision={(decision) => {
        const bridge = (window as unknown as { electronAPI?: ElectronAPI })
          .electronAPI;
        bridge?.permissions.respond(decision);
        setRequest(null);
      }}
    />
  );
}
