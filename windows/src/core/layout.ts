// Island geometry — ported from IslandTypes.swift + IslandWindowController.islandSize
// + IslandRootView.botPosition. All values are logical pixels, identical to the
// macOS app's points.

export type IslandMode = "hidden" | "compact" | "expanded";

export type IslandViewName =
  /** The island at rest: what you can drop on it. */
  | "overview"
  | "confused"
  | "settings"
  | "greeting"
  | "wardrobe"
  | "update"
  | "whatsNew"
  | "dropTargets"
  | "fileAction";

export type BotStateName =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit"
  | "sleeping"
  | "dizzy";

export type BotEmoteName = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

export interface ViewLayout {
  height: number;
  botX: number;
  botY: number | null; // null = auto-centred
  botDiameter: number;
}

// The window is a fixed 720×320 (largest view) like the macOS panel; the island is
// drawn inside it, glued to the top edge and horizontally centred.
export const PANEL_W = 720;
export const PANEL_H = 480;

// No notch on a PC: these are the hidden/compact sizes from docs/SPEC.md.
export const NOTCH_W = 184;
export const NOTCH_H = 32;
export const COMPACT_W = 288; // NOTCH_W + 104
export const EXPANDED_W = 640;

// ── Drop targets ──────────────────────────────────────────────────────────────
// Files dragged over the island: it grows a little into a menu of drop tiles,
// no header, Mochi (a box) in the middle. The tiles' text and icons are in
// island/file-actions.ts (DROP_ACTIONS); only their ids and geometry live here.

/**
 * Every drop action. A drag shows only the ones that fit what is dragged
 * (chooseDropTiles in island/file-actions.ts), 2 to 6 of them, in this order.
 */
export const DROP_ACTION_IDS = [
  "convert", "resize", "images", "merge", "split", "rotate", "compress", "unzip", "zip", "workspace",
] as const;
export type DropActionId = (typeof DROP_ACTION_IDS)[number];
export type DropZone = DropActionId;

/** The tiles shown when nothing is known about the drag (and the overview's line). */
export const DEFAULT_DROP_TILES: readonly DropActionId[] = ["convert", "zip", "resize", "workspace"];

/** Most tiles one drag shows. */
export const MAX_DROP_TILES = 6;

/** The `disabledFeatures` id that switches each drop action off. */
export const DROP_FEATURE: Record<DropActionId, string> = {
  convert: "convert",
  resize: "resize",
  images: "pdf",
  merge: "pdf",
  split: "pdf",
  rotate: "pdf",
  compress: "pdf",
  unzip: "zip",
  zip: "zip",
  workspace: "workspace",
};

/**
 * "grid": two columns of tiles with Mochi in the column between them (2×2 for
 * four); "row": every tile in one row, Mochi in the middle of it.
 */
export type DropLayoutMode = "grid" | "row";
export const DROP_LAYOUT: DropLayoutMode = "grid";

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DropTargetsGeometry {
  w: number;
  h: number;
  /** In island coordinates (origin at its top-left corner), in DROP_ACTION_IDS order. */
  tiles: TileRect[];
  bot: { cx: number; cy: number; diameter: number };
}

/** Insets of #content: 8 on top (no header here), 10 on the sides and the bottom. */
const DROP_PAD_TOP = 8;
const DROP_PAD_SIDE = 10;
const DROP_PAD_BOTTOM = 10;
/** Room for Mochi between the two halves. */
const DROP_BOT_GAP = 76;
/** Between two tiles on the same side. */
const DROP_TILE_GAP = 8;

/** Where the drop tiles go and how big the island grows for them. */
export function dropTargetsGeometry(count: number, mode: DropLayoutMode = DROP_LAYOUT): DropTargetsGeometry {
  const n = Math.max(1, Math.round(count));
  if (mode === "row" || n <= 2) {
    // One row, split in two halves around Mochi: the left half takes the extra one.
    const tileW = n <= 2 ? 212 : 137;
    const tileH = 102;
    const left = Math.ceil(n / 2);
    const right = n - left;
    const half = (k: number) => k * tileW + Math.max(0, k - 1) * DROP_TILE_GAP;
    const w = DROP_PAD_SIDE * 2 + half(left) + DROP_BOT_GAP + half(right);
    const tiles: TileRect[] = [];
    let x = DROP_PAD_SIDE;
    for (let i = 0; i < n; i++) {
      if (i === left) x += DROP_BOT_GAP - DROP_TILE_GAP;
      tiles.push({ x, y: DROP_PAD_TOP, w: tileW, h: tileH });
      x += tileW + DROP_TILE_GAP;
    }
    const cx = right === 0 ? w / 2 : DROP_PAD_SIDE + half(left) + DROP_BOT_GAP / 2;
    return { w, h: DROP_PAD_TOP + tileH + DROP_PAD_BOTTOM, tiles, bot: { cx, cy: DROP_PAD_TOP + tileH / 2, diameter: 44 } };
  }
  // Two columns, row by row (tile i in column i % 2); a column with fewer
  // tiles stretches them over the full height.
  const tileW = 212;
  const rows = Math.ceil(n / 2);
  // Three rows (5 or 6 tiles) are shorter, so the island stays inside its window.
  const tileH = rows <= 2 ? 76 : 58;
  const bodyH = rows * tileH + (rows - 1) * DROP_TILE_GAP;
  const w = DROP_PAD_SIDE * 2 + tileW * 2 + DROP_BOT_GAP;
  const tiles: TileRect[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % 2;
    const inCol = col === 0 ? Math.ceil(n / 2) : Math.floor(n / 2);
    const row = Math.floor(i / 2);
    const h = (bodyH - (inCol - 1) * DROP_TILE_GAP) / inCol;
    tiles.push({
      x: col === 0 ? DROP_PAD_SIDE : DROP_PAD_SIDE + tileW + DROP_BOT_GAP,
      y: DROP_PAD_TOP + row * (h + DROP_TILE_GAP),
      w: tileW,
      h,
    });
  }
  return { w, h: DROP_PAD_TOP + bodyH + DROP_PAD_BOTTOM, tiles, bot: { cx: w / 2, cy: DROP_PAD_TOP + bodyH / 2, diameter: 48 } };
}

/**
 * The tile a point is over: the nearest one, so every point of the island —
 * the gaps and Mochi's column included — picks a tile, and the pointer never
 * has to be inside a tile's own bounds. Ties go to the first tile.
 */
export function dropTileAt(x: number, y: number, tiles: readonly TileRect[]): number {
  let best = -1;
  let bestD = Infinity;
  tiles.forEach((r, i) => {
    const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
    const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** The drop action under a point in island coordinates, among the tiles shown. */
export function dropZoneAt(
  x: number, y: number, tiles: readonly DropActionId[] = DEFAULT_DROP_TILES,
): DropZone | null {
  if (tiles.length === 0) return null;
  const geometry = dropTargetsGeometry(tiles.length);
  return tiles[Math.max(0, dropTileAt(x, y, geometry.tiles))] ?? null;
}

/** The drop targets for the default tiles. */
export const DROP_GEOMETRY = dropTargetsGeometry(DEFAULT_DROP_TILES.length);

// ── Compact notch sides ───────────────────────────────────────────────────────
// Left: the next reminder; right: the rotating live items (island/notch.ts).
// The compact island grows symmetrically so Mochi stays in the middle.

/** Room for Mochi in the middle of the compact island. */
export const COMPACT_BOT_GAP = 40;
/** Between a side's text and the island's edge. */
export const COMPACT_SIDE_PAD = 12;
export const COMPACT_MAX_W = 560;
/** Widest a side's text may be before it ends in an ellipsis. */
export const COMPACT_SIDE_MAX = (COMPACT_MAX_W - COMPACT_BOT_GAP) / 2 - COMPACT_SIDE_PAD;

/** The compact island's width for the two sides' natural widths (0 = empty). */
export function compactWidth(leftW: number, rightW: number): number {
  const side = Math.min(COMPACT_SIDE_MAX, Math.max(0, leftW, rightW));
  if (side <= 0) return COMPACT_W;
  // Whole even pixels: the island is centred, half of it on each side.
  const w = 2 * Math.ceil(side + COMPACT_SIDE_PAD) + COMPACT_BOT_GAP;
  return Math.max(COMPACT_W, Math.min(COMPACT_MAX_W, w));
}

// ── Tabs (the open island at rest) ────────────────────────────────────────────
// Shelf, Reminders, Notes, Tools (src/views/tabs): the overview view hosts them.

/** The island's width while a tab is open (the cards' width). */
export const TAB_WIDTH = EXPANDED_W;
/** Header row (8 top inset + 34) and the 10 px bottom inset around a tab. */
export const TAB_CHROME_H = 52;
export const TABS_MIN_H = 160;
/** The window is PANEL_H tall: the island can't grow past it. */
export const TABS_MAX_H = PANEL_H;
/** Mochi in the header row, left of the tab buttons. */
export const TAB_BOT = { cx: 26, cy: 25, diameter: 20 } as const;

/** The island's height for a tab whose content wants `contentH`. */
export function tabsIslandHeight(contentH: number): number {
  const h = Number.isFinite(contentH) ? contentH + TAB_CHROME_H : TABS_MIN_H;
  return Math.round(Math.max(TABS_MIN_H, Math.min(TABS_MAX_H, h)));
}

/** What sizes the island beyond its mode and view. */
export interface IslandShape {
  /** Drop tiles shown while files are dragged over the island. */
  dropCount: number;
  /** Height of the island while the overview shows a tab; null: the plain overview card. */
  tabsH: number | null;
  /** Width of the compact island (compactWidth). */
  compactW: number;
  /** The tucked pill, sized to what it shows (island/tuck.ts). */
  tuck: TuckShape;
}

/** The tucked pill: its width, and Mochi's centre in it (null: a timer has his place). */
export interface TuckShape {
  w: number;
  botCx: number | null;
}

export const ROUNDED_CORNER = 14; // compact
/** Tucked away (hidden): a pill at the top edge, at least this size. */
export const TUCK_W = 54;
export const TUCK_H = 22;
/** Room the pill keeps around what it shows. Wider content than the wake strip (island.rs) can't fit. */
export const TUCK_MAX_W = 112;

export const DEFAULT_SHAPE: IslandShape = {
  dropCount: DEFAULT_DROP_TILES.length, tabsH: null, compactW: COMPACT_W, tuck: { w: TUCK_W, botCx: TUCK_W / 2 },
};

export const EXPANDED_CORNER = 22;

/** Invisible hover strip that wakes the island when hidden. */
export const WAKE_STRIP_W = 240;
export const WAKE_STRIP_H = 6;

export const VIEW_LAYOUTS: Record<IslandViewName, ViewLayout> = {
  overview: { height: 160, botX: 70, botY: null, botDiameter: 62 },
  confused: { height: 160, botX: 76, botY: null, botDiameter: 66 },
  settings: { height: 160, botX: 54, botY: null, botDiameter: 46 },
  greeting: { height: 150, botX: 320, botY: 90, botDiameter: 0 },
  wardrobe: { height: 160, botX: 68, botY: null, botDiameter: 58 },
  // New version: Mochi on the left, the version and Update now (Mac: .update).
  update: { height: 160, botX: 62, botY: null, botDiameter: 58 },
  // After an update: what the new version brings, then "Your Pod so far".
  // Taller than a card, for two rows of items with their line.
  whatsNew: { height: 222, botX: 62, botY: null, botDiameter: 58 },
  // A file dragged over the island: the drop tiles, Mochi (a box) between them.
  dropTargets: {
    height: DROP_GEOMETRY.h, botX: DROP_GEOMETRY.bot.cx, botY: DROP_GEOMETRY.bot.cy,
    botDiameter: DROP_GEOMETRY.bot.diameter,
  },
  // What became of the drop: moved, convert, ffmpeg, progress, done. Mochi on the left.
  fileAction: { height: 160, botX: 62, botY: null, botDiameter: 56 },
};

/** Island width for an expanded view: every card is 640 wide but the drop targets. */
export function expandedWidth(view: IslandViewName, shape: IslandShape = DEFAULT_SHAPE): number {
  if (view === "dropTargets") return dropTargetsGeometry(shape.dropCount).w;
  return view === "overview" && shape.tabsH != null ? TAB_WIDTH : EXPANDED_W;
}

/** Views drawn without the header row (tabs, gear, sound). */
export function hidesHeader(view: IslandViewName): boolean {
  return view === "dropTargets";
}

export function islandSize(
  mode: IslandMode,
  view: IslandViewName,
  shape: IslandShape = DEFAULT_SHAPE,
): { w: number; h: number } {
  switch (mode) {
    case "hidden":
      // Tucked away (over a maximized window, or folded): a small pill at the top
      // edge with Mochi still in it. Opening grows the island out of it.
      return { w: shape.tuck.w, h: TUCK_H };
    case "compact":
      return { w: shape.compactW, h: NOTCH_H };
    case "expanded": {
      if (view === "dropTargets") {
        const g = dropTargetsGeometry(shape.dropCount);
        return { w: g.w, h: g.h };
      }
      if (view === "overview" && shape.tabsH != null) return { w: TAB_WIDTH, h: shape.tabsH };
      return { w: expandedWidth(view, shape), h: VIEW_LAYOUTS[view].height };
    }
  }
}

export interface BotPlacement {
  cx: number;
  cy: number;
  diameter: number;
  opacity: number;
}

/** IslandRootView.botPosition — cy is measured from the island's top edge. */
export function botPosition(
  mode: IslandMode,
  view: IslandViewName,
  islandH: number,
  shape: IslandShape = DEFAULT_SHAPE,
): BotPlacement {
  switch (mode) {
    case "hidden":
      return {
        cx: shape.tuck.botCx ?? shape.tuck.w / 2, cy: TUCK_H / 2, diameter: 15, opacity: shape.tuck.botCx == null ? 0 : 1,
      };
    case "compact":
      // Mochi centred in the compact island, between its two sides.
      return { cx: shape.compactW / 2, cy: 16, diameter: 20, opacity: 1 };
    case "expanded": {
      if (view === "dropTargets") {
        const g = dropTargetsGeometry(shape.dropCount);
        return { cx: g.bot.cx, cy: g.bot.cy, diameter: g.bot.diameter, opacity: 1 };
      }
      if (view === "overview" && shape.tabsH != null) return { ...TAB_BOT, opacity: 1 };
      const layout = VIEW_LAYOUTS[view];
      if (layout.botY != null) {
        return { cx: layout.botX, cy: layout.botY, diameter: layout.botDiameter, opacity: 1 };
      }
      // Centre of the fixed 84 pt card (8 pt top inset + 34 pt header → content at y = 42)
      const headerBottom = 42;
      const cardH = 84;
      const cy = headerBottom + (islandH - headerBottom - cardH) / 2 + cardH / 2;
      return { cx: layout.botX, cy, diameter: layout.botDiameter, opacity: 1 };
    }
  }
}

export function botGlowColor(s: BotStateName): string {
  switch (s) {
    case "working":
      return "#3B9EFF";
    case "thinking":
      return "#A78BFA";
    case "searching":
      return "#6366F1";
    case "approval":
      return "#F5A524";
    case "error":
      return "#F4505E";
    case "finished":
      return "#34D399";
    case "ratelimit":
      return "#F59E0B";
    default:
      return "#FFFFFF";
  }
}

export function botGlowOpacity(s: BotStateName): number {
  switch (s) {
    case "idle":
    case "sleeping":
      return 0.15;
    case "dizzy":
      return 0;
    default:
      return 0.65;
  }
}

// Card wash colours (CardBackground.washColor)
export type Wash = "red" | "green" | "pink" | "amber" | "cyan" | "indigo" | "soft" | null;

export function washRGBA(wash: Wash): string {
  switch (wash) {
    case "red":
      return "rgba(244,80,94,0.55)";
    case "green":
      return "rgba(52,211,153,0.5)";
    case "pink":
      return "rgba(244,114,182,0.55)";
    case "amber":
      return "rgba(245,165,36,0.42)";
    case "cyan":
      return "rgba(34,211,238,0.38)";
    case "indigo":
      return "rgba(99,102,241,0.5)";
    case "soft":
      return "rgba(255,255,255,0.08)";
    default:
      return "rgba(0,0,0,0)";
  }
}
