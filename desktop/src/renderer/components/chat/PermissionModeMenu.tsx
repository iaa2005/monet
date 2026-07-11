/**
 * Permission mode selector — the 5 Claude Code permission levels, with
 * confirmation dialogs for Auto and Bypass. Mirrors the official composer
 * control. The chosen id is a vendor PermissionMode and flows straight through
 * chat:send → the tool permission gate.
 */

import { useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ClipboardList,
  FileCheck,
  Hand,
  Shield,
  ShieldAlert,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "bypassPermissions";

interface ModeDef {
  id: PermissionMode;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** Tint for the icon + active trigger label. */
  tone: string;
  confirm?: "auto" | "bypass";
}

export const PERMISSION_MODES: ModeDef[] = [
  {
    id: "default",
    label: "Manual permissions",
    hint: "Ask before edits and commands",
    icon: Shield,
    tone: "text-muted-foreground",
  },
  {
    id: "acceptEdits",
    label: "Accept edits",
    hint: "Auto-accept file edits, ask for the rest",
    icon: FileCheck,
    tone: "text-amber-600 dark:text-amber-500",
  },
  {
    id: "plan",
    label: "Plan mode",
    hint: "Read-only — plan before acting",
    icon: ClipboardList,
    tone: "text-sky-600 dark:text-sky-400",
  },
  {
    id: "auto",
    label: "Auto mode",
    hint: "Claude decides what's safe to run",
    icon: Sparkles,
    tone: "text-emerald-600 dark:text-emerald-500",
    confirm: "auto",
  },
  {
    id: "bypassPermissions",
    label: "Bypass permissions",
    hint: "Run everything without asking",
    icon: ShieldAlert,
    tone: "text-destructive",
    confirm: "bypass",
  },
];

/** Home has no filesystem/shell — permissions collapse to two choices,
 * mirroring the official Claude Desktop wording. */
export const HOME_MODES: ModeDef[] = [
  {
    id: "default",
    label: "Manually approve",
    hint: "Claude pauses so you can approve each action.",
    icon: Hand,
    tone: "text-muted-foreground",
  },
  {
    id: "bypassPermissions",
    label: "Skip all approvals",
    hint: "Claude never pauses, even for unsafe actions.",
    icon: AlertTriangle,
    tone: "text-destructive",
    confirm: "bypass",
  },
];

const AUTO_CONFIRMED_KEY = "auto-mode-confirmed";

export function PermissionModeMenu({
  mode,
  onChange,
  home = false,
}: {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  /** Home shows only Manually approve / Skip all approvals. */
  home?: boolean;
}): JSX.Element {
  const [confirm, setConfirm] = useState<null | "auto" | "bypass">(null);
  const modes = home ? HOME_MODES : PERMISSION_MODES;
  // A Code-only mode (plan/acceptEdits/auto) displays as the first Home mode.
  const current = modes.find((m) => m.id === mode) ?? modes[0];

  const pick = (m: ModeDef): void => {
    if (m.confirm === "auto") {
      if (localStorage.getItem(AUTO_CONFIRMED_KEY) === "1") {
        onChange(m.id);
        return;
      }
      setConfirm("auto");
      return;
    }
    if (m.confirm === "bypass") {
      setConfirm("bypass");
      return;
    }
    onChange(m.id);
  };

  const pillBtn =
    "flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(pillBtn, current.tone)}
            title={`Permission mode: ${current.label}`}
          >
            <current.icon className="size-3.5" />
            {current.label}
            <ChevronDown className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-72">
          <DropdownMenuLabel>Permission mode</DropdownMenuLabel>
          {modes.map((m) => (
            <DropdownMenuItem
              key={m.id}
              onClick={() => pick(m)}
              className="items-start gap-2 py-2"
            >
              <m.icon className={cn("mt-0.5 size-4 shrink-0", m.tone)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{m.label}</span>
                  {mode === m.id && <Check className="size-3.5" />}
                </div>
                <div className="text-xs text-muted-foreground">{m.hint}</div>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Auto mode confirmation */}
      <Modal
        open={confirm === "auto"}
        onClose={() => setConfirm(null)}
        title={
          <span className="flex items-center gap-2">
            <Sparkles className="size-4 text-emerald-600 dark:text-emerald-500" />
            Enable auto mode?
          </span>
        }
        className="max-w-md"
      >
        <p className="text-sm text-foreground">
          Claude will decide which actions are safe to run without asking.
          Longer tasks run uninterrupted, with extra safeguards against prompt
          injection.
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          You won&apos;t be asked again for this workspace. Read our security
          guide for details.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              localStorage.setItem(AUTO_CONFIRMED_KEY, "1");
              onChange("auto");
              setConfirm(null);
            }}
          >
            Enable auto mode
          </Button>
        </div>
      </Modal>

      {/* Bypass permissions confirmation */}
      <Modal
        open={confirm === "bypass"}
        onClose={() => setConfirm(null)}
        title={
          <span className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-destructive" />
            Bypass all permissions?
          </span>
        }
        className="max-w-md"
      >
        <p className="text-sm text-foreground">
          Claude will run every action — including file changes and shell
          commands — without asking for approval.
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          Only use this in a trusted, sandboxed workspace. You can switch back to
          a stricter mode at any time.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              onChange("bypassPermissions");
              setConfirm(null);
            }}
          >
            Enable bypass
          </Button>
        </div>
      </Modal>
    </>
  );
}
