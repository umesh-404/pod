// What happens after a file is dropped on one of the two drop tiles: moved
// into the workspace, or converted with ffmpeg (format chips, the ffmpeg
// download when it is missing, progress, done). The card itself is
// views/files.ts; this holds the flow and talks to Rust (workspace.rs,
// convert.rs). Island hands it a few callbacks and stays out of the details.

import {
  Bridge, onEvent,
  type ConvertDone, type ConvertJob, type ConvertProgress, type FfmpegDownloadProgress,
  type FileFailure, type FormatOption, type MoveReport,
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
  resize: { title: N_("Resize image"), sub: N_("Smaller, same look"), icon: "resize", stroke: 1.9 },
  images: { title: N_("Photos to PDF"), sub: N_("One page per photo"), icon: "doc" },
  merge: { title: N_("Merge PDFs"), sub: N_("Into one file"), icon: "stack" },
  split: { title: N_("Split PDF"), sub: N_("One file per page"), icon: "split", stroke: 1.9 },
  rotate: { title: N_("Rotate PDF"), sub: N_("A quarter turn"), icon: "arrowClockwise", stroke: 1.9 },
  compress: { title: N_("Compress PDF"), sub: N_("A smaller file"), icon: "compress", stroke: 1.9 },
  unzip: { title: N_("Unzip"), sub: N_("Extract the files"), icon: "archive", evenOdd: true },
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
const DROP_FIRST_TO_GO: readonly DropActionId[] = ["rotate", "images", "resize", "zip", "split", "compress", "merge", "convert"];

const isMedia = (k: FileKind) => k === "image" || k === "video" || k === "audio";

/**
 * The tiles a drag shows, from what is dragged: video/audio → Convert, Zip,
 * Workspace; images → Convert, Resize, Photos→PDF, Zip, Workspace; PDFs →
 * (Merge for two or more) Split, Rotate, Compress, Zip, Workspace; zips →
 * Unzip, Workspace; folders, other or unknown → Zip, Workspace; a mix → Zip,
 * Workspace, with Convert first when it is all media. Actions whose feature is
 * in `disabled` are left out; never more than MAX_DROP_TILES (Merge, Split and
 * Compress stay longest), Workspace always last.
 */
export function chooseDropTiles(kinds: readonly FileKind[], disabled: readonly string[] = []): DropActionId[] {
  const set = new Set(kinds);
  const only = set.size === 1 ? kinds[0] : null;
  let tiles: DropActionId[];
  if (only === "image") {
    tiles = ["convert", "resize", "images", "zip", "workspace"];
  } else if (only === "pdf") {
    tiles = kinds.length >= 2
      ? ["merge", "split", "rotate", "compress", "zip", "workspace"]
      : ["split", "rotate", "compress", "zip", "workspace"];
  } else if (only === "zip") {
    tiles = ["unzip", "workspace"];
  } else if (set.size > 0 && [...set].every(isMedia)) {
    // Video, audio, or a mix of media.
    tiles = ["convert", "zip", "workspace"];
  } else {
    tiles = ["zip", "workspace"];
  }
  const off = new Set(disabled);
  tiles = tiles.filter((id) => !off.has(DROP_FEATURE[id]));
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
  | { type: "download"; p: FfmpegDownloadProgress };

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

export interface FileActionText {
  title: string;
  sub: string;
  /** "error": the subtitle is a failure, in the error red. */
  tone: "dim" | "error";
}

const KIND_PLURAL: Record<ConvertJob["kind"], string> = {
  video: N_("Convert {count} videos"),
  audio: N_("Convert {count} audio files"),
  image: N_("Convert {count} images"),
};

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
    case "done": {
      const title = s.outputs.length === 1
        ? t("Saved {name}", { name: shortName(baseName(s.outputs[0])) })
        : t("Saved {count} files", { count: s.outputs.length });
      return { title, sub: dirName(s.outputs[0]), tone: "dim" };
    }
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
      const title = s.outputs.length === 1
        ? t("Saved {name}", { name: shortName(baseName(s.outputs[0])) })
        : t("Saved {count} files", { count: s.outputs.length });
      if (s.failed.length === 0) return { title, sub: dirName(s.outputs[0]), tone: "dim" };
      const sub = t("{count} failed: {reason}", { count: s.failed.length, reason: s.failed[0].error });
      return { title, sub, tone: "error" };
    }
    case "soon":
      return {
        title: t("Coming soon"),
        sub: t("{action} isn't available yet.", { action: t(DROP_ACTION_DETAILS[s.action].title) }),
        tone: "dim",
      };
  }
}

/** The progress bar's fill, 0…1; null when the card has no bar. */
export function fileActionProgress(s: FileAction): number | null {
  if (s.kind === "converting") return s.fraction;
  if (s.kind === "downloading") return s.total > 0 ? clamp01(s.received / s.total) : 0;
  return null;
}

/** The moved card for a report from workspace_move_in. */
export function movedState(report: MoveReport): FileAction {
  return { kind: "moved", moved: report.moved, dir: report.dir, failed: report.failed };
}

/** The card for what Zip, Unzip, Resize or a PDF action wrote. */
export function filesState(action: DropActionId, report: { outputs?: string[]; failed?: FileFailure[] }): FileAction {
  return { kind: "written", action, outputs: report.outputs ?? [], failed: report.failed ?? [] };
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
};

// ── Controller ────────────────────────────────────────────────────────────────

export class FileActions {
  private host: FileActionHost;

  constructor(host: FileActionHost) {
    this.host = host;
    void onEvent<ConvertProgress>("convert-progress", (p) => this.apply({ type: "progress", p }));
    void onEvent<ConvertDone>("convert-done", (d) => this.apply({ type: "done", d }));
    void onEvent<FfmpegDownloadProgress>("ffmpeg-download", (p) => this.onDownload(p));
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
      case "zip":
      case "unzip":
        void this.run(action, () => Bridge.archiveRun(paths));
        break;
      case "resize":
        this.set({ kind: "resize", paths }, true);
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

  /** Zip, Unzip, Resize, a PDF action: the working card, then what it wrote. */
  private async run(action: DropActionId, work: () => Promise<{ outputs?: string[]; failed?: FileFailure[] }>) {
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

  /** A format chip: convert now, or first ask for ffmpeg. */
  async pick(format: FormatOption) {
    const s = State.fileAction;
    if (s?.kind !== "pick") return;
    const status = await Bridge.ffmpegStatus();
    if (State.fileAction !== s) return; // cancelled meanwhile
    if (status?.path) {
      void this.start(s.job, format);
      return;
    }
    this.set({ kind: "needsFfmpeg", job: s.job, format, canDownload: status?.canDownload ?? false }, true);
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
    this.set(next, next.kind === "converting");
    if (next.kind === "done") this.host.celebrate();
    if (next.kind === "error") this.host.failed();
  }

  /** Cancel: stops a running conversion, then leaves. */
  cancel() {
    const s = State.fileAction;
    if (s?.kind === "converting") void Bridge.convertCancel(s.job.id);
    this.close();
  }

  /** Done / Cancel on a card with nothing running. */
  close() {
    State.fileAction = null;
    this.host.hold(false);
    this.host.finish();
  }

  openWorkspace() {
    void Bridge.workspaceOpen().catch((err) => this.fail(t("Couldn't open the workspace"), err));
  }

  revealOutput() {
    const s = State.fileAction;
    if ((s?.kind !== "done" && s?.kind !== "written") || !s.outputs[0]) return;
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
