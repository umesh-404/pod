// What happens after files are dropped on a drop tile: moved into the
// workspace, converted with ffmpeg (format chips, the ffmpeg download when it
// is missing, progress, done), zipped, resized, PDF tools, and the file tools
// (text from image, SHA-256, Remove EXIF, batch rename, video to GIF, compress
// video). Everything an action makes is saved in the workspace folder. The
// card itself is views/files.ts; this holds the flow and talks to Rust
// (workspace.rs, convert.rs, archive.rs, resize.rs, pdf.rs, ocr.rs,
// checksum.rs, metaclean.rs, rename.rs). Island hands it a few callbacks and
// stays out of the details.

import {
  Bridge, onEvent,
  type ConvertDone, type ConvertJob, type ConvertProgress, type FfmpegDownloadProgress,
  type FileFailure, type FileHash, type FormatOption, type HashProgress, type MoveReport, type OcrReport,
  type RenameReport,
} from "../core/bridge";
import { DROP_ACTION_IDS, DROP_FEATURE, MAX_DROP_TILES, type DropActionId } from "../core/layout";
import type { ICONS } from "../views/icons";
import { State, type FileAction } from "../core/state";
import { N_, t } from "../i18n/i18n";

export interface FileActionHost {
  /** Puts the file action card up (and keeps it there while `hold` is on). */
  show(): void;
  /** Keeps the island open (picking, downloading, converting) or lets it auto-close again. */
  hold(on: boolean): void;
  /** Done / Cancel: back to the usual view, or folded away. */
  finish(): void;
  /** A conversion saved its files: the success chime and Mochi's happy face. */
  celebrate(): void;
  /** Something went wrong: the error sound. */
  failed(): void;
}

// ── The drop actions ──────────────────────────────────────────────────────────

export interface DropAction {
  id: DropActionId;
  /** English text, translated where it is shown. */
  title: string;
  /** The small line under the title; the workspace tile shows its folder's name instead. */
  sub: string;
  icon: keyof typeof ICONS;
  /** Drawn as a stroke rather than filled. */
  stroke?: number;
  /** The icon has a cut-out (fill-rule even-odd). */
  evenOdd?: boolean;
}

const DROP_ACTION_DETAILS: Record<DropActionId, Omit<DropAction, "id">> = {
  convert: { title: N_("Convert File Format"), sub: "MP4 · MP3 · PNG · GIF…", icon: "convert", stroke: 1.9 },
  gif: { title: N_("Video to GIF"), sub: N_("A short looping clip"), icon: "film", stroke: 1.7 },
  share: { title: N_("Compress video"), sub: N_("Smaller, to share"), icon: "playCompress", stroke: 1.8 },
  ocr: { title: N_("Text from image"), sub: N_("Copy the text in it"), icon: "textScan", stroke: 1.8 },
  resize: { title: N_("Resize image"), sub: N_("Smaller, same look"), icon: "resize", stroke: 1.9 },
  clean: { title: N_("Remove EXIF"), sub: N_("Location, camera, dates"), icon: "pinOff", stroke: 1.8 },
  images: { title: N_("Photos to PDF"), sub: N_("One page per photo"), icon: "doc" },
  merge: { title: N_("Merge PDFs"), sub: N_("Into one file"), icon: "stack" },
  split: { title: N_("Split PDF"), sub: N_("One file per page"), icon: "split", stroke: 1.9 },
  rotate: { title: N_("Rotate PDF"), sub: N_("A quarter turn"), icon: "arrowClockwise", stroke: 1.9 },
  compress: { title: N_("Compress PDF"), sub: N_("A smaller file"), icon: "compress", stroke: 1.9 },
  unzip: { title: N_("Unzip"), sub: N_("Extract the files"), icon: "archive", evenOdd: true },
  rename: { title: N_("Batch rename"), sub: N_("Name them in one go"), icon: "textCursor", stroke: 1.8 },
  sha256: { title: N_("SHA-256 checksum"), sub: N_("Check a download"), icon: "hash", stroke: 1.8 },
  // Folders and unknown files: what they are may not be known during the drag,
  // so one label for both ways (Rust zips or unzips by what it gets).
  zip: { title: N_("Zip / Unzip"), sub: N_("Compress or extract"), icon: "archive", evenOdd: true },
  workspace: { title: N_("Copy to workspace"), sub: N_("Workspace"), icon: "folder" },
};

/** Every drop action, in the order of DROP_ACTION_IDS (core/layout.ts places the ones shown). */
export const DROP_ACTIONS: readonly DropAction[] = DROP_ACTION_IDS.map((id) => ({ id, ...DROP_ACTION_DETAILS[id] }));

/** One action's tile. */
export function dropAction(id: DropActionId): DropAction {
  return { id, ...DROP_ACTION_DETAILS[id] };
}

// ── Which tiles a drag shows (tests/file-actions.test.mjs) ────────────────────

/** What a dragged item is, as far as the drag tells. */
export type FileKind = "image" | "video" | "audio" | "pdf" | "zip" | "folder" | "other";

const EXT_KIND: Record<string, FileKind> = {};
for (const [kind, exts] of [
  ["image", "png jpg jpeg gif webp bmp tif tiff heic heif avif ico"],
  ["video", "mp4 mov mkv avi webm m4v wmv flv mpg mpeg 3gp"],
  ["audio", "mp3 wav m4a aac flac ogg opus wma aiff aif"],
  ["pdf", "pdf"],
  ["zip", "zip"],
] as [FileKind, string][]) {
  for (const ext of exts.split(" ")) EXT_KIND[ext] = kind;
}

/** A dragged path's kind, from its extension. No extension at all: a folder, most likely. */
export function fileKindOfName(path: string): FileKind {
  if (/[\\/]$/.test(path)) return "folder";
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "folder";
  if (dot === 0) return "other";
  return EXT_KIND[name.slice(dot + 1).toLowerCase()] ?? "other";
}

/**
 * A dragged item's kind from its MIME type, which WebView2 gives during the
 * drag (the names come only with the drop). A folder has no type: "other".
 */
export function fileKindOfMime(type: string): FileKind {
  const m = type.toLowerCase().trim();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  if (m === "application/zip" || m === "application/x-zip-compressed" || m === "application/x-zip") return "zip";
  return "other";
}

/** When more would fit than MAX_DROP_TILES, these go first. */
const DROP_FIRST_TO_GO: readonly DropActionId[] = [
  "rotate", "sha256", "images", "rename", "resize", "zip", "split", "compress", "merge", "share", "gif", "clean", "ocr",
  "convert",
];

/**
 * Actions this system can't do: Linux has no OCR of its own. (Rust answers
 * the same if a drop gets there anyway.)
 */
export function unavailableActions(userAgent: string): DropActionId[] {
  return /Linux/i.test(userAgent) && !/Windows/i.test(userAgent) ? ["ocr"] : [];
}

const UNAVAILABLE: readonly DropActionId[] =
  typeof navigator !== "undefined" ? unavailableActions(navigator.userAgent ?? "") : [];

const isMedia = (k: FileKind) => k === "image" || k === "video" || k === "audio";

/**
 * The tiles a drag shows, from what is dragged:
 * - images → Convert, Text from image, Resize, Remove EXIF, Photos→PDF, Rename, SHA-256, Zip;
 * - videos → Convert, Video to GIF, Compress video, Rename, SHA-256, Zip;
 * - audio or a mix of media → Convert, Rename, SHA-256, Zip;
 * - PDFs → (Merge for two or more) Split, Rotate, Compress, Rename, SHA-256, Zip;
 * - zips → Unzip, Rename, SHA-256;
 * - folders → Rename, Zip (no SHA-256: it hashes files);
 * - other, unknown or a mix → Rename, SHA-256, Zip;
 * and Workspace last. Actions whose feature is in `disabled` are left out, and
 * so are the ones this system can't do (`unavailable`); never more than
 * MAX_DROP_TILES (DROP_FIRST_TO_GO says which go first).
 */
export function chooseDropTiles(
  kinds: readonly FileKind[],
  disabled: readonly string[] = [],
  unavailable: readonly DropActionId[] = UNAVAILABLE,
): DropActionId[] {
  const set = new Set(kinds);
  const only = set.size === 1 ? kinds[0] : null;
  let tiles: DropActionId[];
  if (only === "image") {
    tiles = ["convert", "ocr", "resize", "clean", "images", "rename", "sha256", "zip"];
  } else if (only === "video") {
    tiles = ["convert", "gif", "share", "rename", "sha256", "zip"];
  } else if (only === "pdf") {
    tiles = kinds.length >= 2
      ? ["merge", "split", "rotate", "compress", "rename", "sha256", "zip"]
      : ["split", "rotate", "compress", "rename", "sha256", "zip"];
  } else if (only === "zip") {
    tiles = ["unzip", "rename", "sha256"];
  } else if (set.size > 0 && [...set].every(isMedia)) {
    // Audio, or a mix of media.
    tiles = ["convert", "rename", "sha256", "zip"];
  } else if (set.has("folder")) {
    tiles = ["rename", "zip"];
  } else {
    tiles = ["rename", "sha256", "zip"];
  }
  tiles.push("workspace");
  const off = new Set(disabled);
  const cannot = new Set(unavailable);
  tiles = tiles.filter((id) => !off.has(DROP_FEATURE[id]) && !cannot.has(id));
  for (const id of DROP_FIRST_TO_GO) {
    if (tiles.length <= MAX_DROP_TILES) break;
    tiles = tiles.filter((x) => x !== id);
  }
  return tiles;
}

// ── Pure pieces (tests/file-actions.test.mjs) ─────────────────────────────────

/** The last segment of a path, either separator. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** callOrThrow rejects with the Rust error as a string, sometimes prefixed. */
export function errorText(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "");
}

/** Events the card's state reacts to on its own, without a click. */
export type FileActionEvent =
  | { type: "progress"; p: ConvertProgress }
  | { type: "done"; d: ConvertDone }
  | { type: "download"; p: FfmpegDownloadProgress }
  | { type: "hash"; p: HashProgress };

/**
 * The card's next state for a Rust event. Events for another job, or that
 * arrive in a state that does not expect them, change nothing (the same
 * object comes back). A download that completes is left as `downloading` at
 * 100 %: starting the conversion is the controller's move.
 */
export function reduceFileAction(s: FileAction | null, e: FileActionEvent): FileAction | null {
  if (!s) return s;
  switch (e.type) {
    case "progress": {
      if (s.kind !== "converting" || s.job.id !== e.p.id) return s;
      return { ...s, index: e.p.index, count: e.p.count, fraction: clamp01(e.p.fraction) };
    }
    case "done": {
      if (s.kind !== "converting" || s.job.id !== e.d.id) return s;
      if (e.d.cancelled) return null;
      if (e.d.error) return { kind: "error", title: t("The conversion failed"), message: errorText(e.d.error) };
      if (e.d.outputs.length === 0) return { kind: "error", title: t("The conversion failed"), message: t("No file was written.") };
      return { kind: "done", job: s.job, format: s.format, outputs: e.d.outputs };
    }
    case "download": {
      if (s.kind !== "downloading") return s;
      if (e.p.error) return { kind: "error", title: t("ffmpeg couldn't be downloaded"), message: errorText(e.p.error) };
      const total = e.p.total > 0 ? e.p.total : s.total;
      const received = e.p.done && total > 0 ? total : e.p.received;
      return { ...s, received, total };
    }
    case "hash": {
      if (s.kind !== "hashing" || s.id !== e.p.id) return s;
      // Never backwards: a late event must not pull the bar back.
      return { ...s, fraction: Math.max(s.fraction, clamp01(e.p.fraction)) };
    }
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/**
 * A file name cut in the middle so the extension stays: "a-very-lo…name.mp4".
 * Card titles are one line; a long name must not push the rest off.
 */
export function shortName(name: string, max = 32): string {
  const chars = [...name];
  if (chars.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 8 ? [...name.slice(dot)] : [];
  const tail = Math.max(ext.length + 4, Math.floor((max - 1) / 3));
  const head = max - 1 - tail;
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

/** The folder a path is in (the done card's subtitle). */
export function dirName(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/** A SHA-256 on the clipboard (64 hex digits, alone or first in a line like `sha256sum` writes), lowercase. */
export function findSha256(text: string | null | undefined): string | null {
  if (!text || text.length > 4096) return null;
  const word = text.trim().replace(/^sha-?256\s*[:=]?\s*/i, "").split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{64}$/i.test(word) ? word.toLowerCase() : null;
}

/** How the hashes compare with the one on the clipboard: null when there is none to compare with. */
export function hashVerdict(hashes: readonly FileHash[], expected: string | null): "match" | "mismatch" | null {
  if (!expected || hashes.length === 0) return null;
  return hashes.some((h) => h.sha256 === expected) ? "match" : "mismatch";
}

/** What Copy puts on the clipboard: the hash alone, or one `hash  name` line per file (as sha256sum). */
export function hashCopyText(hashes: readonly FileHash[]): string {
  if (hashes.length === 1) return hashes[0].sha256;
  return hashes.map((h) => `${h.sha256}  ${h.name}`).join("\n");
}

export interface FileActionText {
  title: string;
  sub: string;
  /** "error": the subtitle is a failure, in the error red; "ok": a good outcome, in green. */
  tone: "dim" | "error" | "ok";
}

const KIND_PLURAL: Record<ConvertJob["kind"], string> = {
  video: N_("Convert {count} videos"),
  audio: N_("Convert {count} audio files"),
  image: N_("Convert {count} images"),
};

/** "Saved photo.gif to Notch Workspace", "Saved 3 files to Notch Workspace". */
function savedTitle(outputs: readonly string[]): string {
  const folder = baseName(dirName(outputs[0] ?? ""));
  if (!folder || folder === outputs[0]) {
    return outputs.length === 1
      ? t("Saved {name}", { name: shortName(baseName(outputs[0])) })
      : t("Saved {count} files", { count: outputs.length });
  }
  return outputs.length === 1
    ? t("Saved {name} to {folder}", { name: shortName(baseName(outputs[0]), 28), folder })
    : t("Saved {count} files to {folder}", { count: outputs.length, folder });
}

function failedLine(failed: readonly FileFailure[]): string {
  return t("{count} failed: {reason}", { count: failed.length, reason: failed[0].error });
}

/** Title and subtitle of the file action card, in the current language. */
export function fileActionText(s: FileAction): FileActionText {
  switch (s.kind) {
    case "working":
      return { title: s.title, sub: "", tone: "dim" };
    case "moved": {
      const where = baseName(s.dir) || t("the workspace");
      const n = s.moved.length;
      const failedLine = s.failed.length === 0
        ? ""
        : s.failed.length === 1
          ? t("1 couldn't be moved: {reason}", { reason: s.failed[0].error })
          : t("{count} couldn't be moved: {reason}", { count: s.failed.length, reason: s.failed[0].error });
      if (n === 0) {
        const title = s.failed.length === 1
          ? t("Couldn't move {name}", { name: shortName(s.failed[0].name) })
          : t("Nothing was moved");
        const sub = s.failed.length === 1 ? s.failed[0].error : failedLine;
        return { title, sub, tone: "error" };
      }
      const title = n === 1
        ? t("Copied {name} to {folder}", { name: shortName(baseName(s.moved[0]), 28), folder: where })
        : t("Copied {count} items to {folder}", { count: n, folder: where });
      return failedLine ? { title, sub: failedLine, tone: "error" } : { title, sub: s.dir, tone: "dim" };
    }
    case "pick": {
      const n = s.job.names.length;
      const title = n === 1
        ? t("Convert {name}", { name: shortName(s.job.names[0]) })
        : t(KIND_PLURAL[s.job.kind], { count: n });
      return { title, sub: t("Choose a format"), tone: "dim" };
    }
    case "needsFfmpeg":
      return {
        title: t("Converting needs ffmpeg"),
        sub: s.canDownload
          ? t("Free and open source · about 115 MB, downloaded once")
          : t("Install ffmpeg with your package manager, then drop the file again."),
        tone: "dim",
      };
    case "downloading": {
      const mb = (b: number) => Math.round(b / 1_000_000);
      const sub = s.total > 0
        ? t("{received} MB of {total} MB", { received: mb(s.received), total: mb(s.total) })
        : t("{received} MB", { received: mb(s.received) });
      return { title: t("Downloading ffmpeg…"), sub, tone: "dim" };
    }
    case "converting": {
      const i = Math.min(s.index, s.job.names.length - 1);
      const name = shortName(s.job.names[Math.max(0, i)] ?? "", 28);
      const pct = `${Math.round(s.fraction * 100)} %`;
      const sub = s.count > 1 ? `${t("{index} of {count}", { index: i + 1, count: s.count })} · ${pct}` : pct;
      return { title: t("Converting {name} → {format}", { name, format: s.format.label }), sub, tone: "dim" };
    }
    case "done":
      return { title: savedTitle(s.outputs), sub: dirName(s.outputs[0]), tone: "dim" };
    case "error":
      return { title: s.title, sub: s.message, tone: "error" };
    case "resize": {
      const n = s.paths.length;
      const title = n === 1
        ? t("Resize {name}", { name: shortName(baseName(s.paths[0])) })
        : t("Resize {count} images", { count: n });
      return { title, sub: t("Choose a size"), tone: "dim" };
    }
    case "written": {
      if (s.outputs.length === 0) {
        return {
          title: t("{action} failed", { action: t(DROP_ACTION_DETAILS[s.action].title) }),
          sub: s.failed[0]?.error ?? t("No file was written."),
          tone: "error",
        };
      }
      const title = savedTitle(s.outputs);
      if (s.failed.length > 0) return { title, sub: failedLine(s.failed), tone: "error" };
      if (s.action === "clean" && s.cleaned != null) {
        return s.cleaned > 0
          ? { title, sub: t("Location, camera and other photo data removed"), tone: "ok" }
          : { title, sub: t("There was no location or camera data to remove"), tone: "dim" };
      }
      return { title, sub: dirName(s.outputs[0]), tone: "dim" };
    }
    case "soon":
      return {
        title: t("Coming soon"),
        sub: t("{action} isn't available yet.", { action: t(DROP_ACTION_DETAILS[s.action].title) }),
        tone: "dim",
      };
    case "text": {
      const one = s.names.length === 1;
      const title = s.copied
        ? one
          ? t("Copied the text from {name}", { name: shortName(s.names[0], 28) })
          : t("Copied the text from {count} pictures", { count: s.names.length })
        : one
          ? t("Text from {name}", { name: shortName(s.names[0]) })
          : t("Text from {count} pictures", { count: s.names.length });
      return s.failed.length > 0 ? { title, sub: failedLine(s.failed), tone: "error" } : { title, sub: "", tone: "dim" };
    }
    case "hashing": {
      const title = s.names.length === 1
        ? t("SHA-256 of {name}", { name: shortName(s.names[0]) })
        : t("SHA-256 of {count} files", { count: s.names.length });
      return { title, sub: `${Math.round(s.fraction * 100)} %`, tone: "dim" };
    }
    case "hashed": {
      const title = s.hashes.length === 1
        ? t("SHA-256 of {name}", { name: shortName(s.hashes[0].name) })
        : t("SHA-256 of {count} files", { count: s.hashes.length });
      if (s.failed.length > 0) return { title, sub: failedLine(s.failed), tone: "error" };
      switch (hashVerdict(s.hashes, s.expected)) {
        case "match":
          return { title, sub: t("✓ Matches the hash on your clipboard"), tone: "ok" };
        case "mismatch":
          return { title, sub: t("✗ Doesn't match the hash on your clipboard"), tone: "error" };
        default:
          return { title, sub: s.copied ? t("Copied") : t("Copy the published hash first to compare it."), tone: "dim" };
      }
    }
    case "rename": {
      const n = s.job.names.length;
      const title = n === 1
        ? t("Rename {name}", { name: shortName(s.job.names[0]) })
        : t("Rename {count} files", { count: n });
      if (!s.pattern.trim()) return { title, sub: t("Use {name}, {n}, {date} and {ext} in the new name."), tone: "dim" };
      return s.error ? { title, sub: s.error, tone: "error" } : { title, sub: "", tone: "dim" };
    }
    case "renamed": {
      const { renamed, failed } = s.report;
      const n = renamed.length;
      if (n === 0) {
        return {
          title: s.undone ? t("The old names couldn't be put back") : t("Nothing was renamed"),
          sub: failed[0]?.error ?? t("Every file already has that name."),
          tone: failed.length > 0 ? "error" : "dim",
        };
      }
      const title = s.undone
        ? t("Put back {count} names", { count: n })
        : n === 1
          ? t("Renamed {name}", { name: shortName(renamed[0].to) })
          : t("Renamed {count} files", { count: n });
      if (failed.length > 0) return { title, sub: failedLine(failed), tone: "error" };
      const first = `${shortName(renamed[0].from, 24)} → ${shortName(renamed[0].to, 24)}`;
      return { title, sub: n > 1 ? `${first} …` : first, tone: "dim" };
    }
  }
}

/** The progress bar's fill, 0…1; null when the card has no bar. */
export function fileActionProgress(s: FileAction): number | null {
  if (s.kind === "converting") return s.fraction;
  if (s.kind === "downloading") return s.total > 0 ? clamp01(s.received / s.total) : 0;
  if (s.kind === "hashing") return s.fraction;
  return null;
}

/** The moved card for a report from workspace_move_in. */
export function movedState(report: MoveReport): FileAction {
  return { kind: "moved", moved: report.moved, dir: report.dir, failed: report.failed };
}

/** The card for what Zip, Unzip, Resize, a PDF action or Remove EXIF wrote. */
export function filesState(
  action: DropActionId,
  report: { outputs?: string[]; failed?: FileFailure[]; cleaned?: number },
): FileAction {
  const outputs = report.outputs ?? [];
  const failed = report.failed ?? [];
  return report.cleaned == null
    ? { kind: "written", action, outputs, failed }
    : { kind: "written", action, outputs, failed, cleaned: report.cleaned };
}

/** The card for what Text from image read; null when nothing was read (the error card instead). */
export function textState(report: OcrReport): FileAction | null {
  if (!report.text || report.names.length === 0) return null;
  return {
    kind: "text", text: report.text, names: report.names, outputs: report.outputs, failed: report.failed,
    copied: report.copied,
  };
}

export type ResizePreset = "half" | "1920" | "1280" | "800";
/** The resize card's chips, in order; "half" is translated, the others are pixels. */
export const RESIZE_PRESETS: readonly ResizePreset[] = ["half", "1920", "1280", "800"];

type PdfAction = "merge" | "split" | "rotate" | "compress" | "images";
const PDF_ACTIONS: Partial<Record<DropActionId, PdfAction>> = {
  merge: "merge", split: "split", rotate: "rotate", compress: "compress", images: "images",
};

/** The working card's title while each action runs. */
const WORKING: Partial<Record<DropActionId, string>> = {
  zip: N_("Zipping…"),
  unzip: N_("Unzipping…"),
  resize: N_("Resizing…"),
  images: N_("Making the PDF…"),
  merge: N_("Merging the PDFs…"),
  split: N_("Splitting the PDF…"),
  rotate: N_("Rotating the PDF…"),
  compress: N_("Compressing the PDF…"),
  clean: N_("Removing location and EXIF…"),
  ocr: N_("Reading the text…"),
};

/** How long the rename preview waits after a key before asking Rust. */
const PREVIEW_DEBOUNCE = 70;

// ── Controller ────────────────────────────────────────────────────────────────

export class FileActions {
  /** The controller the island made: the file tools' own card controls reach it here (views/files.ts). */
  static current: FileActions | null = null;

  private host: FileActionHost;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewSeq = 0;

  constructor(host: FileActionHost) {
    this.host = host;
    FileActions.current = this;
    void onEvent<ConvertProgress>("convert-progress", (p) => this.apply({ type: "progress", p }));
    void onEvent<ConvertDone>("convert-done", (d) => this.apply({ type: "done", d }));
    void onEvent<FfmpegDownloadProgress>("ffmpeg-download", (p) => this.onDownload(p));
    void onEvent<HashProgress>("hash-progress", (p) => this.apply({ type: "hash", p }));
  }

  /** Files were dropped on a tile. Nothing dropped, or no tile: nothing to do. */
  drop(action: DropActionId | null, paths: string[]): boolean {
    if (!action || paths.length === 0) return false;
    switch (action) {
      case "workspace":
        void this.moveIn(paths);
        break;
      case "convert":
        void this.prepare(paths);
        break;
      case "gif":
      case "share":
        void this.quick(paths, action);
        break;
      case "zip":
      case "unzip":
        void this.run(action, () => Bridge.archiveRun(paths));
        break;
      case "resize":
        this.set({ kind: "resize", paths }, true);
        break;
      case "clean":
        void this.run(action, () => Bridge.cleanRun(paths));
        break;
      case "ocr":
        void this.readText(paths);
        break;
      case "sha256":
        void this.hash(paths);
        break;
      case "rename":
        void this.prepareRename(paths);
        break;
      default: {
        const pdf = PDF_ACTIONS[action];
        if (pdf) void this.run(action, () => Bridge.pdfRun(paths, pdf));
        else this.set({ kind: "soon", action }, false);
        break;
      }
    }
    return true;
  }

  /** A size chip on the resize card. */
  resize(preset: ResizePreset) {
    const s = State.fileAction;
    if (s?.kind !== "resize") return;
    void this.run("resize", () => Bridge.resizeRun(s.paths, preset));
  }

  /** Zip, Unzip, Resize, a PDF action, Remove EXIF: the working card, then what it wrote. */
  private async run(
    action: DropActionId,
    work: () => Promise<{ outputs?: string[]; failed?: FileFailure[]; cleaned?: number }>,
  ) {
    const working: FileAction = { kind: "working", title: t(WORKING[action] ?? DROP_ACTION_DETAILS[action].title) };
    this.set(working, true);
    try {
      const report = await work();
      if (State.fileAction !== working) return; // closed meanwhile
      const next = filesState(action, report);
      this.set(next, false);
      if (next.kind === "written" && next.outputs.length > 0) this.host.celebrate();
      else this.host.failed();
    } catch (err) {
      if (State.fileAction !== working) return;
      this.fail(t("{action} failed", { action: t(DROP_ACTION_DETAILS[action].title) }), err);
    }
  }

  private async moveIn(paths: string[]) {
    this.set({ kind: "working", title: t("Moving to the workspace…") }, true);
    try {
      const report = await Bridge.workspaceMoveIn(paths);
      this.set(movedState(report), false);
      if (report.moved.length === 0) this.host.failed();
    } catch (err) {
      this.fail(t("Couldn't move to the workspace"), err);
    }
  }

  private async prepare(paths: string[]) {
    this.set({ kind: "working", title: t("Reading the files…") }, true);
    try {
      const job = await Bridge.convertPrepare(paths);
      this.set({ kind: "pick", job }, true);
    } catch (err) {
      this.fail(t("Can't convert this"), err);
    }
  }

  /** Video to GIF, Compress video: a conversion with its one format, no chips. */
  private async quick(paths: string[], recipe: "gif" | "share") {
    const working: FileAction = { kind: "working", title: t("Reading the files…") };
    this.set(working, true);
    try {
      const job = await Bridge.convertQuick(paths, recipe);
      if (State.fileAction !== working) return;
      const format = job.formats[0];
      if (!format) throw new Error(t("No file was written."));
      await this.go(job, format, working);
    } catch (err) {
      if (State.fileAction !== working) return;
      this.fail(t("{action} failed", { action: t(DROP_ACTION_DETAILS[recipe].title) }), err);
    }
  }

  /** A format chip: convert now, or first ask for ffmpeg. */
  async pick(format: FormatOption) {
    const s = State.fileAction;
    if (s?.kind !== "pick") return;
    await this.go(s.job, format, s);
  }

  /** Converts `job` to `format` now, or asks for ffmpeg first; `from` is the card it leaves. */
  private async go(job: ConvertJob, format: FormatOption, from: FileAction) {
    const status = await Bridge.ffmpegStatus();
    if (State.fileAction !== from) return; // cancelled meanwhile
    if (status?.path) {
      void this.start(job, format);
      return;
    }
    this.set({ kind: "needsFfmpeg", job, format, canDownload: status?.canDownload ?? false }, true);
  }

  async downloadFfmpeg() {
    const s = State.fileAction;
    if (s?.kind !== "needsFfmpeg") return;
    this.set({ kind: "downloading", job: s.job, format: s.format, received: 0, total: 0 }, true);
    try {
      await Bridge.ffmpegDownload();
    } catch (err) {
      if (State.fileAction?.kind === "downloading") this.fail(t("ffmpeg couldn't be downloaded"), err);
    }
  }

  private onDownload(p: FfmpegDownloadProgress) {
    const before = State.fileAction;
    const next = reduceFileAction(before, { type: "download", p });
    if (next === before) return;
    if (next?.kind === "error") {
      this.set(next, false);
      this.host.failed();
      return;
    }
    this.set(next, true);
    // ffmpeg is there: on with the format that was picked.
    if (p.done && next?.kind === "downloading") void this.start(next.job, next.format);
  }

  private async start(job: ConvertJob, format: FormatOption) {
    this.set({ kind: "converting", job, format, index: 0, count: job.names.length, fraction: 0 }, true);
    try {
      await Bridge.convertStart(job.id, format.id);
    } catch (err) {
      if (State.fileAction?.kind === "converting") this.fail(t("The conversion failed"), err);
    }
  }

  private apply(e: FileActionEvent) {
    const before = State.fileAction;
    const next = reduceFileAction(before, e);
    if (next === before) return;
    if (next == null) {
      // Cancelled from elsewhere while the card was up: it goes.
      this.close();
      return;
    }
    this.set(next, next.kind === "converting" || next.kind === "hashing");
    if (next.kind === "done") this.host.celebrate();
    if (next.kind === "error") this.host.failed();
  }

  // ── Text from image ──

  private async readText(paths: string[]) {
    const working: FileAction = { kind: "working", title: t(WORKING.ocr ?? "") };
    this.set(working, true);
    try {
      const report = await Bridge.ocrRun(paths);
      if (State.fileAction !== working) return;
      const next = textState(report);
      if (!next) {
        this.set({ kind: "error", title: t("No text was found"), message: report.failed[0]?.error ?? "" }, false);
        this.host.failed();
        return;
      }
      // Held: the text is there to read and copy.
      this.set(next, true);
      this.host.celebrate();
    } catch (err) {
      if (State.fileAction !== working) return;
      this.fail(t("{action} failed", { action: t(DROP_ACTION_DETAILS.ocr.title) }), err);
    }
  }

  /** Copy on the text card (the text is usually on the clipboard already). */
  async copyText() {
    const s = State.fileAction;
    if (s?.kind !== "text") return;
    try {
      await Bridge.clipboardSetText(s.text);
      if (State.fileAction === s) this.set({ ...s, copied: true }, true);
    } catch (err) {
      this.fail(t("Couldn't copy"), err);
    }
  }

  // ── SHA-256 ──

  private async hash(paths: string[]) {
    const names = paths.map(baseName);
    let id: number;
    try {
      id = await Bridge.hashNewJob();
    } catch (err) {
      this.fail(t("{action} failed", { action: t(DROP_ACTION_DETAILS.sha256.title) }), err);
      return;
    }
    const hashing: FileAction = { kind: "hashing", id, names, fraction: 0 };
    this.set(hashing, true);
    try {
      const report = await Bridge.hashRun(id, paths);
      const now = State.fileAction;
      if (now?.kind !== "hashing" || now.id !== id) return; // cancelled or closed
      if (report.cancelled) return;
      if (report.hashes.length === 0) {
        this.set({ kind: "error", title: t("{action} failed", { action: t(DROP_ACTION_DETAILS.sha256.title) }), message: report.failed[0]?.error ?? "" }, false);
        this.host.failed();
        return;
      }
      const expected = findSha256(await Bridge.clipboardText());
      if (State.fileAction !== now) return;
      const next: FileAction = { kind: "hashed", hashes: report.hashes, failed: report.failed, expected, copied: false };
      // Held: the hash is there to read, compare and copy.
      this.set(next, true);
      if (hashVerdict(report.hashes, expected) === "mismatch") this.host.failed();
      else this.host.celebrate();
    } catch (err) {
      const now = State.fileAction;
      if (now?.kind !== "hashing" || now.id !== id) return;
      this.fail(t("{action} failed", { action: t(DROP_ACTION_DETAILS.sha256.title) }), err);
    }
  }

  /** Copy on the hash card. */
  async copyHash() {
    const s = State.fileAction;
    if (s?.kind !== "hashed") return;
    try {
      await Bridge.clipboardSetText(hashCopyText(s.hashes));
      // What was compared stays shown; "Copied" only where there was nothing to compare.
      if (State.fileAction === s) this.set({ ...s, copied: true }, true);
    } catch (err) {
      this.fail(t("Couldn't copy"), err);
    }
  }

  // ── Batch rename ──

  private async prepareRename(paths: string[]) {
    const working: FileAction = { kind: "working", title: t("Reading the files…") };
    this.set(working, true);
    try {
      const job = await Bridge.renamePrepare(paths);
      if (State.fileAction !== working) return;
      // Held while typing: the island must not fold under the keyboard.
      this.set({ kind: "rename", job, pattern: "", rows: [], error: null }, true);
    } catch (err) {
      if (State.fileAction !== working) return;
      this.fail(t("{action} failed", { action: t(DROP_ACTION_DETAILS.rename.title) }), err);
    }
  }

  /** The pattern field changed: its preview follows, a moment later. */
  renamePattern(pattern: string) {
    const s = State.fileAction;
    if (s?.kind !== "rename") return;
    const seq = ++this.previewSeq;
    if (this.previewTimer != null) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    if (!pattern.trim()) {
      this.set({ ...s, pattern, rows: [], error: null }, true);
      return;
    }
    // The pattern is kept at once (Enter may come before the preview).
    this.set({ ...s, pattern }, true);
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      void this.preview(seq);
    }, PREVIEW_DEBOUNCE);
  }

  private async preview(seq: number) {
    const s = State.fileAction;
    if (s?.kind !== "rename") return;
    let rows: typeof s.rows = [];
    let error: string | null = null;
    try {
      rows = await Bridge.renamePreview(s.job.id, s.pattern);
    } catch (err) {
      error = errorText(err);
    }
    const now = State.fileAction;
    // A newer key owns the preview.
    if (seq !== this.previewSeq || now?.kind !== "rename" || now.job.id !== s.job.id) return;
    this.set({ ...now, rows, error }, true);
  }

  /** Rename (the button, or Enter in the field). */
  async renameApply() {
    const s = State.fileAction;
    if (s?.kind !== "rename" || !s.pattern.trim()) return;
    if (this.previewTimer != null) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.previewSeq++;
    try {
      const report = await Bridge.renameApply(s.job.id, s.pattern);
      if (State.fileAction !== s) return;
      this.showRenamed(s.job.id, report, false);
    } catch (err) {
      // A pattern Rust refuses: said under the field, the card stays.
      if (State.fileAction === s) {
        this.set({ ...s, error: errorText(err) }, true);
        this.host.failed();
      }
    }
  }

  /** Undo on the renamed card: the old names back, once. */
  async renameUndo() {
    const s = State.fileAction;
    if (s?.kind !== "renamed" || s.undone) return;
    try {
      const report = await Bridge.renameUndo(s.id);
      if (State.fileAction !== s) return;
      this.showRenamed(s.id, report, true);
    } catch (err) {
      if (State.fileAction === s) this.fail(t("The old names couldn't be put back"), err);
    }
  }

  private showRenamed(id: number, report: RenameReport, undone: boolean) {
    // Held until Done: Undo is there to be used.
    this.set({ kind: "renamed", id, report, undone }, !undone && report.renamed.length > 0);
    if (report.renamed.length > 0 && report.failed.length === 0) this.host.celebrate();
    else if (report.failed.length > 0) this.host.failed();
  }

  /** Cancel: stops a running conversion or hash, then leaves. */
  cancel() {
    const s = State.fileAction;
    if (s?.kind === "converting") void Bridge.convertCancel(s.job.id);
    if (s?.kind === "hashing") void Bridge.hashCancel(s.id);
    this.close();
  }

  /** Done / Cancel on a card with nothing running. */
  close() {
    if (this.previewTimer != null) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    State.fileAction = null;
    this.host.hold(false);
    this.host.finish();
  }

  openWorkspace() {
    void Bridge.workspaceOpen().catch((err) => this.fail(t("Couldn't open the workspace"), err));
  }

  revealOutput() {
    const s = State.fileAction;
    if ((s?.kind !== "done" && s?.kind !== "written" && s?.kind !== "text") || !s.outputs[0]) return;
    void Bridge.revealOutput(s.outputs[0]).catch(() => {});
  }

  private fail(title: string, err: unknown) {
    this.set({ kind: "error", title, message: errorText(err) }, false);
    this.host.failed();
  }

  private set(next: FileAction | null, hold: boolean) {
    State.fileAction = next;
    this.host.hold(hold);
    if (next) this.host.show();
    State.notify();
  }
}
