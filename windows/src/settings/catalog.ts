// What Settings → Features and Settings → Notch list, and the pure rules
// behind their switches (kept apart from the DOM so they can be tested).
//
// Feature ids are stored in settings.json (`disabledFeatures`, the ones
// switched OFF: a feature nobody switched off is on, so new ones start on).
// Notch item ids are stored in `leftWidgets` / `rightWidgets` (switched on, in
// the order they take turns) and `leftOff` / `rightOff` (switched off, kept on
// that side).
// Never rename an id.

import { N_ } from "../i18n/i18n";

export interface CatalogItem {
  id: string;
  /** Catalog keys, shown through t(). */
  title: string;
  detail: string;
}

export interface FeatureGroup {
  /** The section's anchor for settings search. */
  anchor: string;
  title: string;
  hint: string;
  items: CatalogItem[];
}

const item = (id: string, title: string, detail: string): CatalogItem => ({ id, title, detail });

export const FEATURE_GROUPS: FeatureGroup[] = [
  {
    anchor: "features.drop",
    title: N_("Drop actions"),
    hint: N_("The tiles that appear when you drag files over the island."),
    items: [
      item("convert", N_("Convert File Format"), N_("Videos, audio and images to another format.")),
      item("zip", N_("Zip / Unzip"), N_("Compress files into a .zip, or extract one.")),
      item("resize", N_("Resize image"), N_("Make images smaller without changing how they look.")),
      item("pdf", N_("PDF tools"), N_("Merge, split and compress PDFs, and turn photos into a PDF.")),
      item("ocr", N_("Text from image"), N_("Read the text in a screenshot or photo, on this computer, and copy it.")),
      item("clean", N_("Remove EXIF"), N_("A copy of a photo without its location, camera and dates.")),
      item("gif", N_("Video to GIF"), N_("Turn a short video into a looping GIF.")),
      item("share", N_("Compress video"), N_("A smaller MP4, at most 1080p, ready to send.")),
      item("sha256", N_("SHA-256 checksum"), N_("Check that a download is exactly the file it should be.")),
      item("rename", N_("Batch rename"), N_("Rename several files at once, with a preview and Undo.")),
      item("workspace", N_("Copy to workspace"), N_("Copy files into your workspace folder.")),
    ],
  },
  {
    anchor: "features.tabs",
    title: N_("Island tabs"),
    hint: N_("The tabs of the open island."),
    items: [
      item("shelf", N_("Shelf"), N_("Keep files at hand and drag them out again.")),
      item("reminders", N_("Reminders"), N_("Quick reminders, with a countdown in the notch.")),
      item("notes", N_("Notes"), N_("Plain text notes, saved on this computer.")),
      item("tools", N_("Tools"), N_("The tools below, together in one tab.")),
    ],
  },
  {
    anchor: "features.notch",
    title: N_("Notch"),
    hint: N_("Shown on the compact notch."),
    items: [
      item("privacy", N_("Camera and microphone"), N_("Which apps are using the camera or the microphone.")),
    ],
  },
  {
    anchor: "features.tools",
    title: N_("Tools"),
    hint: N_("Small tools you can open from the island or with a shortcut."),
    items: [
      item("capture", N_("Screenshot to shelf"), N_("Take a screenshot and keep it on the shelf.")),
      item("focus", N_("Focus timer"), N_("Work and break sessions, counted down in the notch.")),
      item("clipboard", N_("Smart clipboard"), N_("Recognizes what you copy and offers what to do with it.")),
      item("devservers", N_("Dev servers"), N_("The local servers running on this computer, one click to open.")),
    ],
  },
];

export const FEATURE_IDS: string[] = FEATURE_GROUPS.flatMap((g) => g.items.map((i) => i.id));

/** The right side of the notch, in the default order of the catalog. */
export const RIGHT_ITEMS: CatalogItem[] = [
  item("job", N_("File jobs"), N_("Progress of a conversion, a zip or a resize.")),
  item("timer", N_("Focus timer"), N_("Time left in the focus or break session.")),
  item("meeting", N_("Next meeting"), N_("The next event from your calendar links.")),
  item("media", N_("Now playing"), N_("What is playing, with play and pause.")),
  item("shelf", N_("Shelf"), N_("How many files wait on the shelf.")),
  item("glance", N_("System glance"), N_("Processor, memory and battery at a glance.")),
  item("download", N_("New downloads"), N_("A file that just landed in Downloads, ready for the shelf.")),
  item("devservers", N_("Dev servers"), N_("The local servers running right now.")),
];

export const RIGHT_IDS: string[] = RIGHT_ITEMS.map((i) => i.id);

/** Every item a side of the notch can show, in catalog order. */
export const SIDE_ITEMS: CatalogItem[] = [
  item("reminder", N_("Reminders and deadlines"), N_("The reminder that is due, else the next deadline as a countdown.")),
  ...RIGHT_ITEMS,
];

export const SIDE_IDS: string[] = SIDE_ITEMS.map((i) => i.id);

/** The island icon (views/icons.ts) each item shows in the notch, for its row. */
export const SIDE_ICONS: Record<string, { icon: string; stroke?: number }> = {
  reminder: { icon: "bell", stroke: 1.9 }, job: { icon: "convert", stroke: 1.9 }, timer: { icon: "timer" },
  meeting: { icon: "calendar", stroke: 1.7 }, media: { icon: "musicNote" }, shelf: { icon: "tray", stroke: 1.7 },
  glance: { icon: "gauge", stroke: 1.8 }, download: { icon: "download", stroke: 1.9 }, devservers: { icon: "terminal", stroke: 1.9 },
};

/** Where an item sits until it is placed: the reminder on the left, the rest on the right. */
export function defaultSide(id: string): Side {
  return id === "reminder" ? "left" : "right";
}

export type Side = "left" | "right";

/** The notch settings Settings → Notch reads and writes (a subset of Settings). */
export interface NotchSides {
  leftWidgets?: readonly string[];
  rightWidgets?: readonly string[];
  leftOff?: readonly string[];
  rightOff?: readonly string[];
}

/**
 * Both sides' rows, as Settings lists them: on each side the items switched on
 * in their turn's order, then the ones switched off kept there; any item not
 * placed yet (new in this version, or never moved) goes switched off to its
 * default side. Every item is in exactly one row; unknown or repeated ids are
 * left out (an id on both sides stays on the left, as in the notch).
 */
export function sideRows(s: NotchSides): Record<Side, RightRow[]> {
  const seen = new Set<string>();
  const rows: Record<Side, RightRow[]> = { left: [], right: [] };
  const take = (side: Side, ids: readonly string[] | undefined, on: boolean) => {
    for (const id of ids ?? []) {
      if (!SIDE_IDS.includes(id) || seen.has(id)) continue;
      seen.add(id);
      rows[side].push({ id, on });
    }
  };
  take("left", s.leftWidgets ?? ["reminder"], true);
  take("right", s.rightWidgets, true);
  take("left", s.leftOff, false);
  take("right", s.rightOff, false);
  for (const id of SIDE_IDS) if (!seen.has(id)) rows[defaultSide(id)].push({ id, on: false });
  return rows;
}

/** What the settings store for these rows. */
export function sideSettingsOf(rows: Record<Side, readonly RightRow[]>): {
  leftWidgets: string[]; rightWidgets: string[]; leftOff: string[]; rightOff: string[];
} {
  const on = (side: Side) => rows[side].filter((r) => r.on).map((r) => r.id);
  const off = (side: Side) => rows[side].filter((r) => !r.on).map((r) => r.id);
  return { leftWidgets: on("left"), rightWidgets: on("right"), leftOff: off("left"), rightOff: off("right") };
}

/**
 * The rows with item `id` moved to `side` at `index` (its end when left out),
 * on the same side or across. Nothing changes for an unknown id.
 */
export function placeRow(
  rows: Record<Side, readonly RightRow[]>, id: string, side: Side, index?: number,
): Record<Side, RightRow[]> {
  const from: Side | null = rows.left.some((r) => r.id === id) ? "left" : rows.right.some((r) => r.id === id) ? "right" : null;
  const out = { left: [...rows.left], right: [...rows.right] };
  if (!from) return out;
  const row = out[from].find((r) => r.id === id)!;
  out[from] = out[from].filter((r) => r.id !== id);
  const at = Math.max(0, Math.min(out[side].length, index ?? out[side].length));
  out[side].splice(at, 0, row);
  return out;
}

export const ROTATE_RANGE = { min: 3, max: 30 } as const;
export const FOCUS_RANGE = { min: 5, max: 120 } as const;
export const BREAK_RANGE = { min: 1, max: 60 } as const;

/** A number typed in a field, kept in range; `fallback` when it isn't one. */
export function clampNumber(value: unknown, range: { min: number; max: number }, fallback: number): number {
  const raw = String(value ?? "").trim();
  const n = Number(raw);
  if (raw === "" || !Number.isFinite(n)) return fallback;
  return Math.max(range.min, Math.min(range.max, Math.round(n)));
}

/** `disabledFeatures` once `id` is switched on or off. Unknown ids already there are kept. */
export function withFeature(disabled: readonly string[], id: string, on: boolean): string[] {
  const rest = disabled.filter((d) => d !== id);
  return on ? rest : [...rest, id];
}

export function featureOn(disabled: readonly string[] | undefined, id: string): boolean {
  return !(disabled ?? []).includes(id);
}

export interface RightRow {
  id: string;
  on: boolean;
}

/**
 * Every right-side item, in the order Settings lists them: the ones switched
 * on first, in their rotation order, then the others in catalog order.
 * Unknown or repeated ids in the saved list are left out.
 */
export function rightRows(saved: readonly string[] | undefined): RightRow[] {
  const seen = new Set<string>();
  const rows: RightRow[] = [];
  for (const id of saved ?? []) {
    if (!RIGHT_IDS.includes(id) || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, on: true });
  }
  for (const id of RIGHT_IDS) if (!seen.has(id)) rows.push({ id, on: false });
  return rows;
}

/** What `rightWidgets` stores for these rows: the ids switched on, in order. */
export function rightWidgetsOf(rows: readonly RightRow[]): string[] {
  return rows.filter((r) => r.on).map((r) => r.id);
}

/** The rows with row `index` moved one place up (-1) or down (+1); the same rows at an end. */
export function moveRow<T>(rows: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  const out = [...rows];
  if (index < 0 || index >= rows.length || to < 0 || to >= rows.length) return out;
  [out[index], out[to]] = [out[to], out[index]];
  return out;
}

/**
 * A pasted calendar link, cleaned up, or null when it is not a web or webcal
 * link. Surrounding spaces, quotes and angle brackets are removed.
 */
export function calendarLink(input: string): string | null {
  const s = input.trim().replace(/^[<"']+|[>"']+$/g, "").trim();
  if (!/^(https?|webcals?):\/\/[^\s/]+\S*$/i.test(s)) return null;
  return s;
}
