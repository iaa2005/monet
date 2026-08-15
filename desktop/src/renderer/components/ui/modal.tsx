import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "@/components/icons/hg";
import { cn } from "@/lib/utils";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Render without the title bar / padding — child controls the full window. */
  bare?: boolean;
}

/**
 * Centered dialog that floats above the app with a blurred backdrop.
 * Closes on Escape or backdrop click.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  className,
  bare = false,
}: ModalProps): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-md animate-in fade-in duration-150"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl animate-in fade-in zoom-in-95 duration-150",
          className,
        )}
      >
        {bare ? (
          <>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute top-3 right-3 z-20 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
            >
              <X className="size-4" />
            </button>
            {children}
          </>
        ) : (
          <>
            <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-sm font-semibold">{title}</h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-5">{children}</div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
