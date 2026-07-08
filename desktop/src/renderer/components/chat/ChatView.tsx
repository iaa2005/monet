import { useEffect, useState } from "react";
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
import {
  Message,
  MessageAvatar,
  MessageContent,
} from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Shimmer } from "@/components/ui/shimmer";
import { ClaudeMark } from "@/components/ClaudeMark";
import { StatsDashboard } from "@/components/StatsDashboard";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { cn } from "@/lib/utils";
import type { ElectronAPI, PermissionRequest } from "@/types/electron";
import type { ChatMessage } from "@/types/chat";

function AssistantAvatar(): JSX.Element {
  return (
    <MessageAvatar>
      <Avatar size="sm">
        <AvatarFallback className="bg-brand text-white">
          <ClaudeMark className="size-3" />
        </AvatarFallback>
      </Avatar>
    </MessageAvatar>
  );
}

/** Standalone "Working…" row shown while streaming before/between visible
 * assistant text (waiting for the first token or during tool execution). */
function WorkingRow(): JSX.Element {
  return (
    <Message align="start">
      <AssistantAvatar />
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

function MessageRow({ msg }: { msg: ChatMessage }): JSX.Element {
  if (msg.role === "tool" && msg.toolCall) {
    return <ToolCallBubble toolCall={msg.toolCall} />;
  }

  const isUser = msg.role === "user";

  return (
    <Message align={isUser ? "end" : "start"}>
      {!isUser && <AssistantAvatar />}

      <MessageContent>
        {isUser ? (
          <Bubble variant="secondary" align="end">
            <BubbleContent className="whitespace-pre-wrap">
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

export function ChatView(): JSX.Element {
  const messages = useChatStore((s) => s.messages);
  const error = useChatStore((s) => s.error);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const isEmpty = messages.length === 0 && !error;

  // Show the bottom "Working…" row while streaming unless the tail is already
  // an assistant message actively rendering text.
  const last = messages[messages.length - 1];
  const activeText =
    last?.role === "assistant" && last.isStreaming && !!last.content;
  const showWorking = isStreaming && !activeText;

  return (
    <div className="flex h-full flex-col">
      {isEmpty ? (
        <div className="flex-1 overflow-auto">
          <div className="flex flex-col items-center px-4 pt-12 text-center">
            <div className="flex size-9 items-center justify-center rounded-lg bg-brand text-white">
              <ClaudeMark className="size-5" />
            </div>
            <h2 className="mt-4 text-xl font-medium text-foreground">
              How can I help you today?
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Ask a question, describe a task, or type / for commands.
            </p>
          </div>
          <StatsDashboard />
        </div>
      ) : (
        <MessageScrollerProvider autoScroll defaultScrollPosition="end">
          <MessageScroller className="flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
                {messages.map((msg, i) => (
                  <MessageScrollerItem
                    key={msg.id}
                    messageId={msg.id}
                    scrollAnchor={!showWorking && i === messages.length - 1}
                  >
                    <MessageRow msg={msg} />
                  </MessageScrollerItem>
                ))}

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
      )}

      <div className="mx-auto w-full max-w-3xl px-4 pb-1">
        <WorkspacePicker />
      </div>
      <MessageInput />
    </div>
  );
}

/**
 * Permission host — listens for tool permission requests from the agent and
 * shows the approval dialog. One request is pending at a time (tools run
 * sequentially), so a single-slot queue is sufficient.
 */
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
