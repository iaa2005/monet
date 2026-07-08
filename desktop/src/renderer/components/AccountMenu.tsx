import {
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

interface AccountMenuProps {
  name?: string;
  plan?: string;
  email?: string;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
}

export function AccountMenu({
  name = "Aleksandr",
  plan = "Pro",
  email,
  onOpenSettings,
  onOpenAbout,
}: AccountMenuProps): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
        >
          <div className="flex size-6 items-center justify-center rounded-full bg-brand/15 text-[11px] font-medium text-brand">
            {name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[12px] font-medium">{name}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {plan}
            </div>
          </div>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="start" className="w-64">
        <DropdownMenuLabel className="truncate">
          {email ?? `${name} · ${plan}`}
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
          Gift Claude
        </DropdownMenuItem>
        <DropdownMenuItem>
          <ScrollText />
          View changelog
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
