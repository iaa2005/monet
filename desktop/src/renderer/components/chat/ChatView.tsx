import { useEffect } from "react";
import { useChatStore } from "@/stores/chatStore";
import { MarkdownViewer } from "./MarkdownViewer";
import { ToolCallBubble } from "./ToolCallBubble";
import { MessageInput } from "./MessageInput";
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
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { cn } from "@/lib/utils";
import type { ElectronAPI, PermissionRequest } from "@/types/electron";
import type { ChatMessage } from "@/types/chat";

function MessageRow({ msg }: { msg: ChatMessage }): JSX.Element {
  if (msg.role === "tool" && msg.toolCall) {
    return <ToolCallBubble toolCall={msg.toolCall} />;
  }

  const isUser = msg.role === "user";

  return (
    <Message align={isUser ? "end" : "start"}>
      {!isUser && (
        <MessageAvatar>
          <Avatar size="sm">
            <AvatarFallback className="bg-brand text-white">
              <ClaudeMark className="size-3" />
            </AvatarFallback>
          </Avatar>
        </MessageAvatar>
      )}

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
              {msg.content ? (
                <MarkdownViewer content={msg.content} />
              ) : msg.isStreaming ? (
                <Shimmer>Working…</Shimmer>
              ) : null}
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
  const isEmpty = messages.length === 0 && !error;

  return (
    <div className="flex h-full flex-col">
      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center px-4 text-center">
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
      ) : (
        <MessageScrollerProvider autoScroll defaultScrollPosition="end">
          <MessageScroller className="flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
                {messages.map((msg, i) => (
                  <MessageScrollerItem
                    key={msg.id}
                    messageId={msg.id}
                    scrollAnchor={i === messages.length - 1}
                  >
                    <MessageRow msg={msg} />
                  </MessageScrollerItem>
                ))}

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

/** Permission handler hook — auto-allows for now (MVP). */
export function usePermissionHandler(): void {
  useEffect(() => {
    const bridge = (window as unknown as { electronAPI?: ElectronAPI })
      .electronAPI;
    if (!bridge?.permissions) return;

    const unsubscribe = bridge.permissions.onRequest(
      (request: PermissionRequest) => {
        console.log("Permission requested:", request);
        bridge.permissions.respond("allow-once");
      },
    );
    return unsubscribe;
  }, []);
}
