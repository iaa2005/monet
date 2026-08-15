/**
 * Checkpoint picker (Code) — a jump list of every turn in the conversation.
 * Picking one rewinds to that point: reverts the workspace to before that turn
 * and drops the prompt back into the composer to edit and resend (same as the
 * per-message "Rewind to here").
 */
import { useState } from "react";
import { History, X } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Portal } from "@/components/ui/portal";
import { useChatStore } from "@/stores/chatStore";
import type { ChatMessage } from "@/types/chat";

export function CheckpointPicker({
  onClose,
}: {
  onClose: () => void;
}): JSX.Element {
  const messages = useChatStore((s) => s.messages);
  const rewindAndEdit = useChatStore((s) => s.rewindAndEdit);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const [pendingTurn, setPendingTurn] = useState<ChatMessage | null>(null);

  const turns = messages.filter((m) => m.role === "user");

  const picker = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-base font-semibold">Rewind to a checkpoint</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Jump back to any turn — reverts the workspace to before it and puts the
          prompt back in the composer to edit and resend.
        </p>

        {turns.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
            No turns yet.
          </div>
        ) : (
          <div className="-mr-1 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
            {turns.map((m, i) => (
              <button
                key={m.id}
                type="button"
                disabled={isStreaming}
                onClick={() => setPendingTurn(m)}
                className="group flex w-full items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-black/[0.03] disabled:opacity-50 dark:hover:bg-white/[0.04]"
              >
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {m.content || "(empty)"}
                </span>
                <History className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            ))}
          </div>
        )}
      </div>
      <Modal
        open={pendingTurn !== null}
        onClose={() => setPendingTurn(null)}
        title="Rewind to checkpoint?"
      >
        <p className="text-sm text-muted-foreground">
          This will restore the workspace to before the selected turn and put its
          prompt back in the composer for editing and resubmission.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          The project folder is shared by every chat and branch of this project.
          Reverting files also undoes changes made from other chats after this
          point.
        </p>
        {pendingTurn && (
          <p className="mt-3 truncate rounded-lg bg-muted px-3 py-2 text-sm">
            {pendingTurn.content || "(empty)"}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setPendingTurn(null)}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (!pendingTurn) return;
              const id = pendingTurn.id;
              setPendingTurn(null);
              onClose();
              void rewindAndEdit(id);
            }}
            className="rounded-lg bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground transition-opacity hover:opacity-90"
          >
            Rewind
          </button>
        </div>
      </Modal>
    </div>
  );
  return <Portal>{picker}</Portal>;
}
