/**
 * The app's icon set: hugeicons, through @iconify/react.
 *
 * One module, one name each. Every component here is the same call the
 * Iconify docs show — `<Icon icon="hugeicons:…" />` — and the export it lives
 * under is the name the app was already using, so a screen changes its icons
 * by changing one import line and nothing else. That is the whole reason this
 * file is a list of aliases rather than a set of new names: 81 files, 168
 * icons, and no appetite for renaming <ChevronRight> to <ArrowRight01> in all
 * of them.
 *
 * The pairing is a judgement, not a translation. The two sets are named by
 * different people — lucide says `Trash2`, hugeicons says `delete-02`; lucide
 * says `Chevron*`, and hugeicons' chevrons are the `arrow-*-01` family while
 * its `arrow-*-02` are arrows with a stem. Where hugeicons has nothing for a
 * lucide idea (Ghost, Boxes) the nearest honest picture is used and named
 * here, not fudged at the call site.
 *
 * OFFLINE, and this is not optional: @iconify/react fetches unknown icons
 * from api.iconify.design at render time, which in a packaged Electron app
 * behind a file:// origin means icons that quietly never arrive. The subset
 * beside this file is generated from the installed @iconify-json/hugeicons by
 * scripts/build-hugeicons-subset.mjs, registered here before anything renders,
 * and checked by scripts/hugeicons-probe.ts — which also refuses a name this
 * set does not have.
 *
 * Obsidian keeps its own drawing (ObsidianIcon), as do the app's own marks in
 * ./index.tsx: those exist precisely because no general set has them.
 */

import { Icon, addCollection, type IconProps as IconifyProps } from "@iconify/react";
import type { ComponentType, SVGProps } from "react";
import subset from "./hugeicons-subset.json";

addCollection(subset as Parameters<typeof addCollection>[0]);

/** lucide's prop shape, which is what the call sites are written against:
 * plain SVG attributes plus `size`, a number Iconify spells as width+height. */
export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number | string;
}
/** What lucide called its icon type — imported by name in a few components. */
export type LucideIcon = ComponentType<IconProps>;

function hg(name: string): LucideIcon {
  const id = `hugeicons:${name}`;
  const C = ({ size, ...rest }: IconProps): JSX.Element => (
    <Icon
      icon={id}
      // Draw on the FIRST render, not after an effect. Without this the
      // component returns an empty <span> and swaps the SVG in on mount —
      // sensible when an icon might still be coming over the wire, pointless
      // when it is already in memory, and visible as a blink on every list
      // that mounts (probed: renders `<span></span>` without it).
      ssr
      {...(size != null ? { width: size, height: size } : {})}
      // SVGProps is the wider set (React knows 480-odd attributes; Iconify
      // declares the handful it forwards). Everything here IS forwarded onto
      // the <svg> it renders — the cast says so rather than pretending the
      // two lists are the same list.
      {...(rest as Omit<IconifyProps, "icon">)}
    />
  );
  C.displayName = name;
  return C;
}

export const Activity = hg("activity-01");
export const AlarmClock = hg("alarm-clock");
export const AlertCircle = hg("alert-circle");
export const AlertTriangle = hg("alert-01");
export const Archive = hg("archive-01");
export const ArrowDown = hg("arrow-down-02");
export const ArrowDownIcon = ArrowDown;
export const ArrowLeft = hg("arrow-left-02");
export const ArrowRight = hg("arrow-right-02");
export const ArrowUp = hg("arrow-up-02");
export const ArrowUpCircle = hg("circle-arrow-up-01");
export const AudioLines = hg("audio-wave-01");
export const Ban = hg("cancel-circle");
export const Binary = hg("binary-code");
export const Blocks = hg("dashboard-square-01");
export const BookMarked = hg("book-bookmark-01");
export const BookOpen = hg("book-open-01");
export const Bot = hg("bot");
export const Box = hg("package");
export const Boxes = hg("cube");
export const Brain = hg("brain-01");
export const CalendarClock = hg("calendar-01");
export const Camera = hg("camera-01");
export const Check = hg("tick-02");
// hugeicons' chevrons are the -01 family; -02 are arrows with a stem.
export const ChevronDown = hg("arrow-down-01");
export const ChevronLeft = hg("arrow-left-01");
export const ChevronRight = hg("arrow-right-01");
export const ChevronUp = hg("arrow-up-01");
export const ChevronsDownUp = hg("chevrons-down-up");
export const ChevronsUpDown = hg("arrow-up-down");
export const Chrome = hg("chrome");
export const Circle = hg("circle");
export const CircleCheck = hg("checkmark-circle-02");
export const CircleDot = hg("record");
export const ClipboardCheck = hg("task-done-01");
export const ClipboardList = hg("clipboard");
export const ClipboardPaste = hg("clipboard-paste");
export const Clock = hg("clock-01");
export const Cloud = hg("cloud");
export const Code = hg("code");
export const Code2 = hg("code-simple");
export const Compass = hg("compass");
export const Container = hg("cube");
export const Copy = hg("copy-01");
export const CornerDownLeft = hg("arrow-turn-backward");
export const Cpu = hg("cpu");
export const Database = hg("database-01");
export const Download = hg("download-05");
export const Eraser = hg("eraser-01");
export const ExternalLink = hg("square-arrow-up-right");
export const Eye = hg("view");
export const EyeOff = hg("view-off");
export const FileCheck = hg("file-validation");
export const FileDiff = hg("file-diff");
export const FilePlus = hg("file-plus");
export const FileScan = hg("file-scan");
export const FileText = hg("file-01");
export const Film = hg("film-01");
export const Filter = hg("filter");
export const FlaskConical = hg("test-tube-01");
export const Folder = hg("folder-01");
export const FolderGit2 = hg("folder-02");
export const FolderOpen = hg("folder-open");
export const FolderPlus = hg("folder-add");
export const Gauge = hg("dashboard-speed-01");
export const Gavel = hg("court-law");
export const Ghost = hg("incognito");
export const Gift = hg("gift");
export const GitBranch = hg("git-branch");
export const GitFork = hg("git-fork");
export const GitPullRequest = hg("git-pull-request");
export const Globe = hg("globe");
export const GraduationCap = hg("mortarboard-01");
export const Hand = hg("hand-grab");
export const HelpCircle = hg("help-circle");
export const History = hg("clock-arrow-down");
export const Home = hg("home-01");
export const Image = hg("image-01");
export const Info = hg("information-circle");
export const KeyRound = hg("key-01");
export const Layers = hg("layers-01");
export const LineChart = hg("chart-line-data-01");
export const ListChecks = hg("check-list");
export const ListEnd = hg("add-to-list");
export const ListTodo = hg("task-01");
export const Loader2 = hg("loading-03");
export const Lock = hg("lock");
export const LogIn = hg("login-01");
export const LogOut = hg("logout-01");
export const Mail = hg("mail-01");
export const Maximize2 = hg("maximize-01");
export const MessageCircleQuestion = hg("message-question");
export const MessageSquare = hg("message-01");
export const MessageSquarePlus = hg("message-add-01");
export const Mic = hg("mic-01");
export const Minimize2 = hg("minimize-01");
export const Minus = hg("minus-sign");
export const MinusCircle = hg("minus-sign-circle");
export const Monitor = hg("computer");
export const Moon = hg("moon-02");
export const MoonStar = hg("moon-01");
export const MoreVertical = hg("more-vertical");
export const MousePointerClick = hg("cursor-pointer-01");
export const NotebookPen = hg("notebook-01");
export const PackageSearch = hg("package-search");
export const Palette = hg("paint-board");
export const PanelLeft = hg("panel-left");
export const PanelRight = hg("panel-right");
export const Paperclip = hg("attachment-01");
export const Pause = hg("pause");
export const Pencil = hg("pencil-edit-02");
export const Pin = hg("pin");
export const PlaneLanding = hg("airplane-landing-01");
export const Play = hg("play");
export const PlayCircle = hg("play-circle");
export const Plug = hg("plug-01");
export const Plus = hg("plus-sign");
export const Power = hg("power");
export const Puzzle = hg("puzzle");
export const Radio = hg("radio");
export const RefreshCw = hg("refresh");
export const RotateCcw = hg("rotate-left-01");
export const RotateCw = hg("rotate-right-01");
export const Save = hg("floppy-disk");
export const ScanText = hg("scan");
export const Scissors = hg("scissor-01");
export const ScrollText = hg("scroll-01");
export const Search = hg("search-01");
export const Send = hg("sent");
export const Server = hg("server-stack-01");
export const Settings = hg("settings-01");
export const Settings2 = hg("settings-02");
export const Shield = hg("shield-01");
export const ShieldAlert = hg("shield-02");
export const ShieldCheck = hg("security-check");
export const ShieldQuestion = hg("shield-question-mark");
export const SlidersHorizontal = hg("sliders-horizontal");
export const Sparkles = hg("sparkles");
export const Square = hg("square");
export const SquareArrowOutUpRight = hg("square-arrow-up-right");
export const SquareTerminal = hg("computer-terminal-01");
export const Star = hg("star");
export const Store = hg("store-01");
export const Sun = hg("sun-02");
export const Table2 = hg("table-02");
export const Target = hg("target-01");
export const Telescope = hg("telescope-01");
export const Terminal = hg("computer-terminal-01");
export const TerminalSquare = hg("computer-terminal-02");
export const TextCursor = hg("cursor-text");
export const Timer = hg("timer-01");
export const Trash2 = hg("delete-02");
// lucide renamed AlertTriangle to TriangleAlert; both names are in the app.
export const TriangleAlert = AlertTriangle;
export const Type = hg("text-font");
export const Undo2 = hg("undo-02");
export const Upload = hg("upload-05");
export const User = hg("user");
export const Video = hg("video-01");
export const Volume2 = hg("volume-high");
export const Wand2 = hg("magic-wand-02");
export const Waypoints = hg("connect");
export const Webhook = hg("webhook");
export const Wind = hg("fast-wind");
export const Wrench = hg("wrench-01");
export const X = hg("cancel-01");
export const Zap = hg("zap");
