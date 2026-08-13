/**
 * Permission mode selector — the 5 standard permission levels, with
 * confirmation dialogs for Auto and Bypass. Mirrors the official composer
 * control. The chosen id is a vendor PermissionMode and flows straight through
 * chat:send → the tool permission gate.
 */

import { useState } from "react";
import {
  AlertTriangle,
  Check,
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
  /** Tint for the icon in the menu. */
  tone: string;
  /**
   * The filled chip the trigger wears in this mode.
   *
   * It lives on the mode rather than in the markup because the colour IS the
   * mode: green runs on its own judgement, amber writes files, blue only
   * reads, red asks nothing. A reader glancing at the composer should get the
   * answer from the shape of the chip, before reading a word of it.
   */
  badge: string;
  confirm?: "auto" | "bypass";
}

/** The quiet one: nothing is being waived, so the chip stays neutral. */
const BADGE_NEUTRAL = "bg-muted text-muted-foreground";
const BADGE_AMBER = "bg-warn/15 text-warn";
const BADGE_BLUE = "bg-brand-wash text-brand";
const BADGE_GREEN = "bg-green-bg text-green-text";
const BADGE_RED = "bg-red-bg text-red-text";

export const PERMISSION_MODES: ModeDef[] = [
  {
    id: "default",
    label: "Manual permissions",
    hint: "Ask before edits and commands",
    icon: Shield,
    tone: "text-muted-foreground",
    badge: BADGE_NEUTRAL,
  },
  {
    id: "acceptEdits",
    label: "Accept edits",
    hint: "Auto-accept file edits, ask for the rest",
    icon: FileCheck,
    tone: "text-amber-600 dark:text-amber-500",
    badge: BADGE_AMBER,
  },
  {
    id: "plan",
    label: "Plan mode",
    hint: "Read-only — plan before acting",
    icon: ClipboardList,
    tone: "text-sky-600 dark:text-sky-400",
    badge: BADGE_BLUE,
  },
  {
    id: "auto",
    label: "Auto mode",
    hint: "Code Monet decides what's safe to run",
    icon: Sparkles,
    tone: "text-green-text",
    badge: BADGE_GREEN,
    confirm: "auto",
  },
  {
    id: "bypassPermissions",
    label: "Bypass permissions",
    hint: "Run everything without asking",
    icon: ShieldAlert,
    tone: "text-red-text",
    badge: BADGE_RED,
    confirm: "bypass",
  },
];

/** Home has no filesystem/shell, so the approval choices collapse to two —
 * plus Plan, which is about WHEN work starts rather than what it may touch.
 * Home needs it as much as Code does: the model can put a chat into plan mode
 * itself (EnterPlanMode), and without the entry here there was no way for the
 * user to turn it back off. */
export const HOME_MODES: ModeDef[] = [
  {
    id: "default",
    label: "Manually approve",
    hint: "Code Monet pauses so you can approve each action.",
    icon: Hand,
    tone: "text-muted-foreground",
    badge: BADGE_NEUTRAL,
  },
  {
    id: "plan",
    label: "Plan mode",
    hint: "Research first — nothing runs until you approve a plan.",
    icon: ClipboardList,
    tone: "text-link",
    badge: BADGE_BLUE,
  },
  {
    id: "bypassPermissions",
    label: "Skip all approvals",
    hint: "Code Monet never pauses, even for unsafe actions.",
    icon: AlertTriangle,
    tone: "text-red-text",
    badge: BADGE_RED,
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

  /*
   * The label alone, in a chip the colour of the mode.
   *
   * The icon and the chevron were saying what the words already say — a
   * warning triangle beside "Skip all approvals" is the same sentence twice,
   * and every control on this row opens a menu, so a caret on one of them
   * marks nothing. The colour does the work instead: the composer answers
   * "what may it do without me?" before a word of it is read.
   *
   * Hover dims rather than repaints, because a chip that changes colour on
   * hover would be saying something about the mode, and nothing has changed.
   */
  const pillBtn =
    "flex h-6 items-center rounded-md px-2 text-xs font-medium transition-opacity hover:opacity-80";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(pillBtn, current.badge)}
            title={`Permission mode: ${current.label}`}
          >
            {current.label}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-72">
          <DropdownMenuLabel>Permission mode</DropdownMenuLabel>
          {modes.map((m) => (
            <DropdownMenuItem
              key={m.id}
              onClick={() => pick(m)}
              className="items-start gap-2 py-2"
              variant={m.id === "bypassPermissions" ? "destructive" : "default"}
            >
              <m.icon className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{m.label}</span>
                  {mode === m.id && <Check className="size-3.5" />}
                </div>
                <div className={cn("text-xs", m.id === "bypassPermissions" ? "text-red-text" : "text-muted-foreground")}>{m.hint}</div>
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
            <Sparkles className="size-4 text-green-text" />
            Enable auto mode?
          </span>
        }
        className="max-w-md"
      >
        <p className="text-sm text-foreground">
          Code Monet will decide which actions are safe to run without asking.
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
            <AlertTriangle className="size-4 text-red-text" />
            Bypass all permissions?
          </span>
        }
        className="max-w-md"
      >
        <p className="text-sm text-foreground">
          Code Monet will run every action — including file changes and shell
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
