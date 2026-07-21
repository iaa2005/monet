import { useEffect, useState } from "react";
import {
  BookOpen,
  Settings,
  Globe,
  HelpCircle,
  ArrowUpCircle,
  Download,
  Gift,
  ScrollText,
  Info,
  LogOut,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

interface AccountMenuProps {
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  onOpenDocs: () => void;
}

export function AccountMenu({
  onOpenSettings,
  onOpenAbout,
  onOpenDocs,
}: AccountMenuProps): JSX.Element {
  const [name, setName] = useState("friend");
  const [avatar, setAvatar] = useState<string | null>(null);

  useEffect(() => {
    const a = api();
    if (!a) return;
    void a.profile.get().then((p) => {
      if (p.name) setName(p.name);
      setAvatar(p.avatarDataUrl);
    });
    return a.profile.onChanged((p) => {
      if (p.name) setName(p.name);
      setAvatar(p.avatarDataUrl);
    });
  }, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
        >
          {avatar ? (
            <img
              src={avatar}
              alt=""
              className="size-6 shrink-0 rounded-full object-cover"
            />
          ) : (
            <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[11px] font-medium text-brand">
              {(name.trim()[0] ?? "?").toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[14px] font-medium">{name}</div>
          </div>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="start" className="w-64">
        <DropdownMenuLabel className="truncate">
          {name}
        </DropdownMenuLabel>

        <DropdownMenuItem onClick={onOpenSettings}>
          <Settings />
          Settings
          <DropdownMenuShortcut>Ctrl ,</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Globe />
          Language
          <ChevronRight className="ml-auto size-4" />
        </DropdownMenuItem>
        <DropdownMenuItem>
          <HelpCircle />
          Get help
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem>
          <ArrowUpCircle />
          Upgrade plan
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Download />
          Get apps and extensions
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Gift />
          Gift Code Monet
        </DropdownMenuItem>
        <DropdownMenuItem>
          <ScrollText />
          View changelog
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenDocs}>
          <BookOpen />
          Get Help
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenAbout}>
          <Info />
          About project
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem variant="destructive">
          <LogOut />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
