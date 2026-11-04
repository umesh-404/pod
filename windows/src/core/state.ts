// App state — mirror of AppState.swift (the parts the island needs).

import { DEFAULT_DROP_TILES, type BotStateName, type DropActionId, type DropZone, type IslandMode, type IslandViewName } from "./layout";
import type { ConvertJob, FileFailure, FileHash, FormatOption, RenameJob, RenameReport, RenameRow } from "./bridge";
import type { TabId } from "../views/tabs/tab";
import type { Bindings } from "./shortcuts";
import { DEFAULT_OUTFIT, type Outfit } from "../mochi/wardrobe";

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  /** Hovering the island opens it all the way (off: hovering only peeks). */
  openOnHover: boolean;
  /** "primary", "cursor", or `at:<x>,<y>` for one display (logical origin). */
  screen: string;
  autostart: boolean;
  /** Global shortcuts the user changed, by action id (see core/shortcuts.ts). */
  shortcuts: Bindings;
  /**
   * Stew's outfit: "auto" (dresses for the season), "none" or an outfit id.
   * Same raw values as the Mac's "mochiOutfit"; read it through parseOutfit.
   */
  mochiOutfit: string;
  /**
   * Interface language: "" follows the system (when Pod has its language,
   * else English), or one of src/i18n's codes ("fr", "pt-BR", "zh-Hans"…).
   */
  language: string;
  /** Stew on the desktop. Rust owns it: whatever the page sends back is ignored. */
  desktopMochi?: {
    onDesktop: boolean;
    spot: { x: number; y: number; space: string } | null;
  };
  /** Date and time in the middle of the compact island. */
  showClock: boolean;
  /** Temporary workspace folder; "" = default. Read-only here: workspace_change sets it. */
  workspaceDir: string;
  /** ffmpeg picked by hand; "" = find it. Read-only here: ffmpeg_choose sets it. */
  ffmpegPath: string;
  /**
   * The items switched on on the notch's left side, in the order they take
   * turns (ids: island/notch-items.ts SIDE_ITEM_IDS). Default: the reminder.
   */
  leftWidgets: string[];
  /** The same for the right side. */
  rightWidgets: string[];
  /** Items switched off that Settings keeps on the left / right side. */
  leftOff: string[];
  rightOff: string[];
  /** Seconds each left-side item stays before the next one. */
  leftRotateSeconds: number;
  /** Seconds each right-side item stays before the next one. */
  rotateSeconds: number;
  /** Calendar links (.ics) for "next meeting". */
  calendarUrls: string[];
  focusMinutes: number;
  breakMinutes: number;
  /** Features switched off in Settings; they disappear from the island. */
  disabledFeatures: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  openOnHover: true,
  screen: "primary",
  autostart: false,
  shortcuts: {},
  mochiOutfit: DEFAULT_OUTFIT,
  language: "",
  showClock: false,
  workspaceDir: "",
  ffmpegPath: "",
  leftWidgets: ["reminder"],
  rightWidgets: ["job", "timer", "media", "shelf"],
  leftOff: [],
  rightOff: [],
  leftRotateSeconds: 6,
  rotateSeconds: 6,
  calendarUrls: [],
  focusMinutes: 25,
  breakMinutes: 5,
  disabledFeatures: [],
};

/**
 * What the file action card shows, after a drop on one of the two tiles.
 * `format` is the one picked in the format chips; `job` comes from convert_prepare.
 */
export type FileAction =
  | { kind: "working"; title: string }
  | { kind: "moved"; moved: string[]; dir: string; failed: FileFailure[] }
  | { kind: "pick"; job: ConvertJob }
  | { kind: "needsFfmpeg"; job: ConvertJob; format: FormatOption; canDownload: boolean }
  | { kind: "downloading"; job: ConvertJob; format: FormatOption; received: number; total: number }
  | { kind: "converting"; job: ConvertJob; format: FormatOption; index: number; count: number; fraction: number }
  | { kind: "done"; job: ConvertJob; format: FormatOption; outputs: string[] }
  | { kind: "error"; title: string; message: string }
  /** Resize: the size presets, for these dropped images. */
  | { kind: "resize"; paths: string[] }
  /**
   * Zip, Unzip, Resize, a PDF action or Remove EXIF finished: what it wrote,
   * what failed. `cleaned`: how many clean copies had metadata taken out.
   */
  | { kind: "written"; action: DropActionId; outputs: string[]; failed: FileFailure[]; cleaned?: number }
  /** Text from image: what was read, the .txt files written, whether it is on the clipboard. */
  | { kind: "text"; text: string; names: string[]; outputs: string[]; failed: FileFailure[]; copied: boolean }
  /** SHA-256 running: `fraction` over all the files. */
  | { kind: "hashing"; id: number; names: string[]; fraction: number }
  /** SHA-256 done; `expected`: a hash found on the clipboard, to compare with. */
  | { kind: "hashed"; hashes: FileHash[]; failed: FileFailure[]; expected: string | null; copied: boolean }
  /** Batch rename: the pattern typed so far and its preview (or why it can't be used). */
  | { kind: "rename"; job: RenameJob; pattern: string; rows: RenameRow[]; error: string | null }
  /** Renamed (or put back, `undone`), with Undo until it is used. */
  | { kind: "renamed"; id: number; report: RenameReport; undone: boolean }
  /** A drop action not wired up yet. */
  | { kind: "soon"; action: DropActionId };

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  fileDragOver = false;
  /** The drop tile under a file being dragged over the island; null when none. */
  dropZone: DropZone | null = null;
  /** The drop tiles this drag shows, chosen from what is dragged (2 to 6). */
  dropTiles: readonly DropActionId[] = DEFAULT_DROP_TILES;
  /** The workspace folder's name on the "Copy to shelf" tile; null until known. */
  workspaceName: string | null = null;
  /** The file action card (views/files.ts), driven by island/file-actions.ts. */
  fileAction: FileAction | null = null;

  /**
   * Stew is out of the island — on the desktop, flying, or being dragged
   * there — so the island's own Stew is hidden (AppState.mochiOnDesktop).
   */
  mochiOnDesktop = false;

  /** Outfit shown on Stew while the pointer rests on a wardrobe button. */
  wardrobePreview: Outfit | null = null;

  lastActivity = performance.now();

  /** The tabs the open island offers (their feature on), in header order. */
  tabs: readonly TabId[] = [];
  /** The tab the open island shows; null when no tab is available. */
  tab: TabId | null = null;

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? "idle";
  }

  /** What the island opens on. */
  defaultView(): IslandViewName {
    return "overview";
  }
}

export const State = new AppState();
