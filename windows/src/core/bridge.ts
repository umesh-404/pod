// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Settings } from "./state";
import type { UpdateStatus } from "./update";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[pod] ${cmd} failed`, err);
    return null;
  }
}

/** Who wants Rust's dev-server watcher on (Bridge.devserversWatch). */
const devserverWatchers = new Set<string>();

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),
  /** The system's languages as the webview sees them, for Rust's own texts (i18n.rs). */
  setSystemLanguages: (languages: string[]) => call<void>("set_system_languages", { languages }),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),
  fitZoom: (dpr: number) => call<boolean>("fit_zoom", { dpr }),

  /** Displays the island can be pinned to: `key` is what `settings.screen` stores. */
  listMonitors: () => call<{ key: string; label: string }[]>("list_monitors"),

  openUrl: (url: string) => call<void>("open_url", { url }),

  /** Which of these sounds have a file of the user's own in the sounds folder. */
  customSounds: (names: readonly string[]) => call<string[]>("custom_sounds", { names }),
  /** The user's file for one sound, as raw bytes. */
  customSound: (name: string) => call<ArrayBuffer>("custom_sound", { name }),
  revealSoundsFolder: () => call<void>("reveal_sounds_folder"),
  /** Tells the island to read the sounds folder again ("sounds-changed"). */
  reloadSounds: () => call<void>("reload_sounds"),

  quit: () => call<void>("quit_app"),

  openSettingsWindow: () => call<void>("open_settings_window"),
  /** Whether the Pod window is on screen; its page animates only then (hub/hero.ts). */
  hubShown: () => call<boolean>("hub_shown"),

  /** Writes to %LOCALAPPDATA%\Pod\pod.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Files ─────────────────────────────────────────────────────────────────
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),

  // ── Workspace and conversion (src-tauri/src/workspace.rs, convert.rs) ──────
  workspaceInfo: () => call<WorkspaceInfo>("workspace_info"),
  /** Moves dropped files and folders into the workspace. Only paths from a real drop are accepted. */
  workspaceMoveIn: (paths: string[]) => callOrThrow<MoveReport>("workspace_move_in", { paths }),
  /** Settings: pick a new folder, confirm, move everything over. null when cancelled. */
  workspaceChange: () => callOrThrow<WorkspaceChange | null>("workspace_change"),
  workspaceOpen: () => callOrThrow<void>("workspace_open"),
  /** Dropped on "Convert": what they are and the formats they can become. */
  convertPrepare: (paths: string[]) => callOrThrow<ConvertJob>("convert_prepare", { paths }),
  /** Dropped on "Video to GIF" or "Compress video": a job with that one target, started with convertStart. */
  convertQuick: (paths: string[], recipe: "gif" | "share") => callOrThrow<ConvertJob>("convert_quick", { paths, recipe }),
  /** Starts the conversion; `convert-progress` and then `convert-done` follow. */
  convertStart: (id: number, format: string) => callOrThrow<void>("convert_start", { id, format }),
  convertCancel: (id: number) => call<void>("convert_cancel", { id }),
  ffmpegStatus: () => call<FfmpegStatus>("ffmpeg_status"),
  /** Starts downloading ffmpeg (Windows); `ffmpeg-download` events follow. */
  ffmpegDownload: () => callOrThrow<void>("ffmpeg_download"),
  /** Settings: pick ffmpeg by hand. null when cancelled. */
  ffmpegChoose: () => callOrThrow<FfmpegStatus | null>("ffmpeg_choose"),
  /** Shows a converted file (or the workspace) selected in the file manager. */
  revealOutput: (path: string) => callOrThrow<void>("reveal_output", { path }),
  /** Zip / Unzip the dropped paths (only paths from a real drop are accepted). */
  archiveRun: (paths: string[]) => callOrThrow<ArchiveReport>("archive_run", { paths }),
  /** What is in the workspace, newest first. */
  shelfList: () => call<ShelfItem[]>("shelf_list"),
  /** Starts a native drag (copy) of shelf items out of the island. Call on pointer-drag start. */
  shelfDrag: (names: string[]) => callOrThrow<void>("shelf_drag", { names }),
  /** Sends shelf items to the Recycle Bin. */
  shelfRemove: (names: string[]) => callOrThrow<void>("shelf_remove", { names }),
  shelfOpen: (name: string) => callOrThrow<void>("shelf_open", { name }),
  /** `data:image/png` thumbnail, at most `size` px on its long side; null when none. */
  shelfThumb: (name: string, size: number) => call<string | null>("shelf_thumb", { name, size }),
  /** The file picker; the picked files are copied onto the shelf. Their new names ([] when cancelled). */
  shelfAdd: () => callOrThrow<string[]>("shelf_add"),
  /** Whether the active window reaches under the notch now; `notch-covered` (boolean) on each change. */
  notchCovered: () => call<boolean>("notch_covered"),

  // ── More drop actions and tools (resize.rs, pdf.rs, capture.rs, quicknote.rs, clipboard.rs) ──
  resizeRun: (paths: string[], preset: "half" | "1920" | "1280" | "800") =>
    callOrThrow<FilesReport>("resize_run", { paths, preset }),
  pdfRun: (paths: string[], action: "merge" | "split" | "rotate" | "compress" | "images") =>
    callOrThrow<FilesReport>("pdf_run", { paths, action }),
  /** Dropped pictures and PDFs into the PDF editor, which opens in the Pod window (pdfstudio.rs). */
  pdfStudioOpen: (paths: string[]) => callOrThrow<{ failed: FileFailure[]; sources: unknown[] }>("pdf_studio_open", { paths }),

  // ── File tools (ocr.rs, checksum.rs, metaclean.rs, rename.rs) ──────────────
  /** The text in dropped pictures: on the clipboard and in "<name> (text).txt" files in the workspace. */
  ocrRun: (paths: string[]) => callOrThrow<OcrReport>("ocr_run", { paths }),
  hashNewJob: () => callOrThrow<number>("hash_new_job"),
  /** SHA-256 of the dropped files; `hash-progress` (HashProgress) events while it runs. */
  hashRun: (id: number, paths: string[]) => callOrThrow<HashReport>("hash_run", { id, paths }),
  hashCancel: (id: number) => call<void>("hash_cancel", { id }),
  /** Clean copies of dropped pictures, without location and EXIF, in the workspace. */
  cleanRun: (paths: string[]) => callOrThrow<CleanReport>("clean_run", { paths }),
  renamePrepare: (paths: string[]) => callOrThrow<RenameJob>("rename_prepare", { paths }),
  renamePreview: (id: number, pattern: string) => callOrThrow<RenameRow[]>("rename_preview", { id, pattern }),
  renameApply: (id: number, pattern: string) => callOrThrow<RenameReport>("rename_apply", { id, pattern }),
  renameUndo: (id: number) => callOrThrow<RenameReport>("rename_undo", { id }),
  /** Snipping overlay → PNG on the shelf; rejects with "cancelled". */
  captureToShelf: () => callOrThrow<string>("capture_to_shelf"),
  noteSave: (name: string | null, text: string) => callOrThrow<string>("note_save", { name, text }),
  noteRead: (name: string) => callOrThrow<string>("note_read", { name }),
  clipboardText: () => call<string | null>("clipboard_text"),
  clipboardSetText: (text: string) => callOrThrow<void>("clipboard_set_text", { text }),
  /**
   * While on, `dev-servers` events (DevServer[]) when the list changes. Rust
   * keeps one switch, but the notch's item and the Tools tab both want it:
   * each says who it is, and the watcher runs while either wants it (the Tools
   * tab closing used to stop the notch's item from updating).
   */
  devserversWatch: (on: boolean, who: "notch" | "tools" = "notch") => {
    const before = devserverWatchers.size > 0;
    if (on) devserverWatchers.add(who);
    else devserverWatchers.delete(who);
    const now = devserverWatchers.size > 0;
    return now === before ? Promise.resolve(null) : call<void>("devservers_watch", { on: now });
  },
  devserversNow: () => call<DevServer[]>("devservers_now"),
  devserverOpen: (port: number) => callOrThrow<void>("devserver_open", { port }),

  // ── Notch sides (media.rs, sysglance.rs, privacy.rs, calendar.rs, downloads.rs, reminders.rs) ──
  /** While on, `media` events follow the system's current media session. */
  mediaWatch: (on: boolean) => call<void>("media_watch", { on }),
  mediaNow: () => call<NowPlaying | null>("media_now"),
  mediaControl: (action: "playpause" | "next" | "previous") => callOrThrow<void>("media_control", { action }),
  /** While on, a `system-glance` event every 2 s. */
  glanceWatch: (on: boolean) => call<void>("glance_watch", { on }),
  /** While on, `privacy` events when the apps using the mic or camera change. */
  privacyWatch: (on: boolean) => call<void>("privacy_watch", { on }),
  privacyNow: () => call<InUse>("privacy_now"),
  calendarRefresh: () => callOrThrow<Meeting | null>("calendar_refresh"),
  calendarTest: (url: string) => callOrThrow<number>("calendar_test", { url }),
  /** While on, `download-new` events for files landing in Downloads. */
  downloadsWatch: (on: boolean) => call<void>("downloads_watch", { on }),
  downloadToShelf: (path: string) => callOrThrow<string>("download_to_shelf", { path }),
  remindersList: () => call<Reminder[]>("reminders_list"),
  reminderParse: (input: string) => call<ParsedReminder>("reminder_parse", { input }),
  /** `deadline`: shown as a countdown on the left of the notch until due. */
  reminderAdd: (text: string, due: number, deadline: boolean) =>
    callOrThrow<Reminder>("reminder_add", { text, due, deadline }),
  reminderDone: (id: number) => callOrThrow<void>("reminder_done", { id }),
  reminderSnooze: (id: number, minutes: number) => callOrThrow<void>("reminder_snooze", { id, minutes }),

  /** Tray → Pause. Stops the pollers (update checks), not just the island. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),

  // ── Global shortcuts ──────────────────────────────────────────────────────
  /** How each global shortcut went when Rust last registered them. */
  shortcutsStatus: () => call<ShortcutsReport>("shortcuts_status"),
  /** Lets go of every global shortcut while Settings records a new one. */
  shortcutsSuspend: (suspended: boolean) => call<void>("shortcuts_suspend", { suspended }),

  // ── Stew on the desktop (src-tauri/src/desktop.rs) ───────────────────────
  desktopInfo: () => call<DesktopInfo>("desktop_mochi_info"),
  /** Dragged out of the island: (x, y) is the pointer in island-window coordinates. */
  desktopPickUp: (x: number, y: number) => call<boolean>("desktop_mochi_pick_up", { x, y }),
  /** Linux: the pointer moved during that drag (Windows carries him from Rust). */
  desktopCarry: (x: number, y: number) => call<void>("desktop_mochi_carry", { x, y }),
  desktopCarryEnd: (x: number, y: number) => call<void>("desktop_mochi_carry_end", { x, y }),
  /** A drag started on the desktop Stew; resolves to his top-left corner. */
  desktopDragBegin: () => call<[number, number] | null>("desktop_mochi_drag_begin"),
  /** X11: top-left corner, physical pixels. */
  desktopDragMove: (x: number, y: number) => call<void>("desktop_mochi_drag_move", { x, y }),
  desktopDragEnd: (x: number, y: number) => call<void>("desktop_mochi_drag_end", { x, y }),
  /** From the island to his spot. False: no spot on any connected display.
   *  `anywhere`: the first-visit corner then, rather than staying home. */
  desktopFlyOut: (anywhere = false) => call<boolean>("desktop_mochi_fly_out", { anywhere }),
  /** To the island, then hidden. `forget`: he lives in the island again. */
  desktopFlyHome: (forget: boolean) => call<boolean>("desktop_mochi_fly_home", { forget }),
  /** Asleep, the cursor poll stops. */
  desktopSetAsleep: (asleep: boolean) => call<void>("desktop_mochi_set_asleep", { asleep }),

  // ── New versions (src-tauri/src/update.rs) ────────────────────────────────
  updateStatus: () => call<UpdateStatus>("update_status"),
  /** The island's question or Settings' toggle: may Pod look at GitHub on its own? */
  updateSetConsent: (allowed: boolean) => call<void>("update_set_consent", { allowed }),
  updateSetAutoInstall: (on: boolean) => call<void>("update_set_auto_install", { on }),
  /** "Check now": one look at GitHub, the toggle on or off. */
  updateCheck: () => call<UpdateStatus>("update_check"),
  /** The island opened the card Rust offered ("ask" or "announce"). */
  updateShown: (kind: "ask" | "announce") => call<void>("update_shown", { kind }),
  /** Settings → Install X: opens the island's update card. */
  updateShow: () => call<void>("update_show"),
  updateLater: () => call<void>("update_later"),
  /** Blue Stew in the tray while a new version waits (tray.rs). */
  trayUpdateHint: (on: boolean) => call<void>("tray_update_hint", { on }),
  updateDismiss: () => call<void>("update_dismiss"),
  /** "Update now" (Windows): download, check the SHA-256, run the installer, quit. */
  updateInstall: () => call<void>("update_install"),
  /** The release's page on github.com. */
  updateOpenPage: () => call<void>("update_open_page"),

  // ── Self-repair (src-tauri/src/heal.rs) ───────────────────────────────────
  /** The last check: each part of Pod's state, and what was repaired. */
  healStatus: () => call<HealthReport>("heal_status"),
  /** "Check now": every check at once, repairs included. */
  healCheck: () => call<HealthReport>("heal_check"),
};

/** One check of the self-repair: "ok", "repaired", "warning" or "skipped". */
export interface HealthCheck {
  id: string;
  title: string;
  status: "ok" | "repaired" | "warning" | "skipped";
  detail: string;
}

export interface HealthReport {
  enabled: boolean;
  checking: boolean;
  /** Milliseconds since the epoch; null before the first check. */
  lastCheck: number | null;
  checks: HealthCheck[];
  /** Newest first; `at` in milliseconds since the epoch. */
  repairs: { at: number; text: string }[];
}

export type ShortcutStatus =
  | "active" | "off" | "inUse" | "duplicate" | "invalid"
  | "typesCharacter" | "unsupported" | "notPorted"
  /** Wayland: handed to the desktop's portal, no answer yet / left out by it. */
  | "pending" | "refused";

export interface ShortcutsReport {
  /** `trigger`: on Wayland, the keys the desktop says run it, in its words. */
  actions: { id: string; status: ShortcutStatus; typed?: string; trigger?: string }[];
  /** "wayland" or "no-display" when no key grab can be made. */
  blocked: string | null;
  /** `<executable> --shortcut`: append an action id for a desktop shortcut. */
  command: string;
  /** Wayland: the shortcuts went to the desktop's GlobalShortcuts portal. */
  portal?: "pending" | "active" | null;
}

/** How the desktop Stew's window works here (platform::DesktopMode). */
export type DesktopMode = "poll" | "window" | "layer" | "off";

export interface DesktopInfo {
  mode: DesktopMode;
  /** He was on the desktop when the app last quit. */
  onDesktop: boolean;
}

/** An event for one window only (island ⇄ desktop Stew). Never throws. */
export async function emitToWindow(label: string, event: string, payload?: unknown) {
  if (!IS_TAURI) return;
  try {
    await emitTo(label, event, payload);
  } catch (err) {
    console.error(`[pod] emit ${event} failed`, err);
  }
}

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Pod");
  return invoke<T>(cmd, args);
}

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "screen-changed"; payload: null };

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
  /** Text dragged in instead of files (a selection from a page or an app), on drop. */
  text?: string;
  /** Pointer in window CSS pixels, on enter/over (and drop when known). */
  x?: number;
  y?: number;
}

export interface WorkspaceInfo {
  dir: string;
  isDefault: boolean;
  items: number;
}

export interface FileFailure {
  name: string;
  error: string;
}

export interface MoveReport {
  dir: string;
  moved: string[];
  failed: FileFailure[];
}

export interface WorkspaceChange {
  info: WorkspaceInfo;
  moved: number;
  failed: FileFailure[];
  note: string | null;
}

export interface FormatOption {
  id: string;
  label: string;
}

export interface ConvertJob {
  id: number;
  names: string[];
  kind: "video" | "audio" | "image";
  formats: FormatOption[];
}

export interface FfmpegStatus {
  path: string | null;
  source: "settings" | "downloaded" | "path" | null;
  canDownload: boolean;
  downloading: boolean;
}

/** `media` event (null when no session). */
export interface NowPlaying {
  title: string;
  artist: string;
  app: string;
  playing: boolean;
  art: string | null;
}

/** `system-glance` event. */
export interface Glance {
  cpu: number;
  ramUsed: number;
  ramTotal: number;
  battery: { percent: number; charging: boolean } | null;
  netDown: number;
  netUp: number;
}

/** `privacy` event. */
export interface InUse {
  mic: string[];
  camera: string[];
}

/** `next-meeting` event (null when nothing is coming up). Times in ms. */
export interface Meeting {
  title: string;
  start: number;
  end: number;
  link: string | null;
  location: string;
}

/** `download-new` event. */
export interface NewDownload {
  path: string;
  name: string;
  size: number;
}

/** `reminders-changed` carries Reminder[]; `reminder-due` carries one Reminder. */
export interface Reminder {
  id: number;
  text: string;
  due: number;
  fired: boolean;
  deadline: boolean;
}

export interface ParsedReminder {
  text: string;
  due: number | null;
}

/** ocr_run. */
export interface OcrReport {
  text: string;
  /** The pictures text was found in. */
  names: string[];
  outputs: string[];
  failed: FileFailure[];
  /** The text is on the clipboard. */
  copied: boolean;
}

export interface FileHash {
  name: string;
  /** Lowercase hex, 64 digits. */
  sha256: string;
  size: number;
}

/** hash_run. */
export interface HashReport {
  hashes: FileHash[];
  failed: FileFailure[];
  cancelled: boolean;
}

/** `hash-progress`: fraction 0…1 over all the files of job `id`. */
export interface HashProgress {
  id: number;
  fraction: number;
}

/** clean_run: `cleaned` of the outputs had metadata taken out. */
export interface CleanReport {
  outputs: string[];
  failed: FileFailure[];
  cleaned: number;
}

export interface RenameJob {
  id: number;
  names: string[];
}

/** One file's old and new name. */
export interface RenameRow {
  from: string;
  to: string;
}

/** rename_apply / rename_undo. */
export interface RenameReport {
  renamed: RenameRow[];
  unchanged: number;
  failed: FileFailure[];
}

/** resize_run / pdf_run. `shelf-changed` carries ShelfItem[]. */
export interface FilesReport {
  outputs: string[];
  failed: FileFailure[];
}

/** `dev-servers` event carries DevServer[]. */
export interface DevServer {
  port: number;
  pid: number;
  process: string;
  url: string;
}

export interface ArchiveReport {
  mode: "zip" | "unzip";
  outputs: string[];
  failed: FileFailure[];
}

export interface ShelfItem {
  name: string;
  isDir: boolean;
  size: number;
  /** ms since the Unix epoch */
  modified: number;
  ext: string;
}

/** `convert-progress`: overall fraction 0…1 across all files of the job. */
export interface ConvertProgress {
  id: number;
  index: number;
  count: number;
  fraction: number;
}

/** `convert-done`: full paths of the files written. */
export interface ConvertDone {
  id: number;
  outputs: string[];
  error: string | null;
  cancelled: boolean;
}

/** `ffmpeg-download`: total is 0 while unknown. */
export interface FfmpegDownloadProgress {
  received: number;
  total: number;
  done: boolean;
  error: string | null;
}

/** No dragover for this long: the drag is over, wherever it went. */
const DRAG_QUIET_MS = 900;
/** How long a drop waits for Rust's paths before reading the files' bytes. */
const DROP_ANSWER_MS = 1500;
/** How long one path-less file may take to be read and saved before the drop goes on without it. */
const DROP_SAVE_MS = 8000;

/** `p`, or a rejection after `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** A dropped file the OS has no path for, saved from its bytes (Rust drop_save). */
export async function saveDroppedFile(file: File): Promise<string> {
  let name = file.name || "";
  // A picture dragged from a page can come without a name or an extension.
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
    const ext = (file.type.split("/")[1] ?? "").replace("jpeg", "jpg").replace(/[^a-z0-9].*$/i, "");
    name = `${name || "picture"}${ext ? `.${ext}` : ""}`;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  void invoke("log_line", { message: `drop: read ${bytes.length} bytes of "${name}"` }).catch(() => {});
  return invoke<string>("drop_save", bytes, { headers: { "x-pod-name": encodeURIComponent(name) } });
}

interface WebView2Bridge {
  postMessageWithAdditionalObjects(message: unknown, objects: ArrayLike<unknown>): void;
}

/**
 * Files dragged onto the island. Only reaches us when the window takes the mouse.
 *
 * On Windows WebView2 takes the drop itself, as in Edge — Tauri's drop handling
 * never sees drags from the classic Explorer folder view (see
 * src-tauri/src/webview_drop.rs). Enter/over/leave come straight from the page;
 * the drop hands the File objects to Rust, which answers with their real paths
 * as a `file-drag` event. Elsewhere (Linux) Tauri's own drag events still do it.
 */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  const webview = (window as unknown as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview;
  if (!webview) {
    return getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload as DragDropPayload & { position?: { x: number; y: number } };
      // Tauri reports the position in physical pixels.
      const dpr = window.devicePixelRatio || 1;
      const pos = p.position ? { x: p.position.x / dpr, y: p.position.y / dpr } : {};
      handler({ type: p.type, paths: p.paths, ...pos });
    });
  }
  // Files, or text from another app or page. A drag that starts inside Pod
  // (moving text in the note field) is Pod's own and isn't a drop for the island.
  let ownDrag = false;
  window.addEventListener("dragstart", () => (ownDrag = true), true);
  window.addEventListener("dragend", () => (ownDrag = false), true);
  const hasFiles = (e: DragEvent) => {
    const types = e.dataTransfer?.types ?? [];
    return types.includes("Files") || (!ownDrag && types.includes("text/plain"));
  };
  // dragenter/dragleave fire for every element crossed; only the outermost pair counts.
  let depth = 0;

  // A drag that ends without a drop or a leave reaching the page (a browser
  // drag released where WebView2 won't take it) would leave the tiles up for
  // good. dragover keeps firing while a drag is over the window, even with the
  // pointer still; when it stops, the drag is over.
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const stopWatch = () => {
    if (watchdog != null) clearTimeout(watchdog);
    watchdog = null;
  };
  const watch = () => {
    stopWatch();
    watchdog = setTimeout(() => {
      watchdog = null;
      if (depth === 0) return;
      depth = 0;
      handler({ type: "leave" });
    }, DRAG_QUIET_MS);
  };

  const onEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    watch();
    if (depth++ === 0) handler({ type: "enter", x: e.clientX, y: e.clientY });
  };
  const onOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    // Without this WebView2 refuses the drop — or navigates to the file.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    watch();
    handler({ type: "over", x: e.clientX, y: e.clientY });
  };
  const onLeave = (e: DragEvent) => {
    if (!hasFiles(e) || depth === 0) return;
    if (--depth === 0) {
      stopWatch();
      handler({ type: "leave" });
    }
  };
  // The File objects of the last drop: a browser's "virtual" file (a WhatsApp
  // Web picture) has no path, so Rust answers "" for it and its bytes are
  // saved instead (drop_save).
  let dropped: File[] = [];
  let answered: ReturnType<typeof setTimeout> | null = null;
  const note = (message: string) => void invoke("log_line", { message }).catch(() => {});
  const finish = async (paths: string[]) => {
    if (answered != null) clearTimeout(answered);
    answered = null;
    const files = dropped;
    dropped = [];
    const out: string[] = [];
    for (let i = 0; i < Math.max(paths.length, files.length); i++) {
      const path = paths[i] ?? "";
      if (path) out.push(path);
      else if (files[i]) {
        const f = files[i];
        note(`drop: no path for "${f.name}" (${f.type || "no type"}, ${f.size} bytes), saving its bytes`);
        // A browser's virtual file can stall while its bytes are read: a drop
        // always ends, with or without that file, so the tiles never stay up.
        const saved = await withTimeout(saveDroppedFile(f), DROP_SAVE_MS).catch((err) => {
          note(`drop: couldn't save "${f.name}": ${err}`);
          return null;
        });
        if (saved) out.push(saved);
      }
    }
    handler({ type: "drop", paths: out });
  };
  const onDrop = (e: DragEvent) => {
    if (ownDrag) return;
    e.preventDefault();
    depth = 0;
    stopWatch();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) {
      // Text, not files: the island makes a note of it.
      const text = e.dataTransfer?.getData("text/plain") ?? "";
      handler({ type: "drop", paths: [], ...(text ? { text } : {}) });
      return;
    }
    dropped = [...files];
    note(`drop: ${files.length} file(s) let go, asking for their paths`);
    // Rust answers at once; if it doesn't, the bytes are the way in. Armed
    // first: handing over a browser's virtual file can throw, and the drop
    // must end all the same.
    answered = setTimeout(() => void finish([]), DROP_ANSWER_MS);
    try {
      webview.postMessageWithAdditionalObjects("pod-file-drop", files);
    } catch (err) {
      note(`drop: WebView2 wouldn't hand the files over (${err}), reading their bytes`);
      void finish([]);
    }
  };

  window.addEventListener("dragenter", onEnter);
  window.addEventListener("dragover", onOver);
  window.addEventListener("dragleave", onLeave);
  window.addEventListener("drop", onDrop);
  const unlisten = await listen<DragDropPayload>("file-drag", (e) => {
    if (e.payload.type === "drop" && dropped.length > 0) void finish(e.payload.paths ?? []);
    else handler(e.payload);
  });
  return () => {
    window.removeEventListener("dragenter", onEnter);
    window.removeEventListener("dragover", onOver);
    window.removeEventListener("dragleave", onLeave);
    window.removeEventListener("drop", onDrop);
    unlisten();
  };
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
