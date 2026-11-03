// Drag and drop onto the island: the drop tiles' geometry and hit test
// (core/layout.ts), and the file action card's pure pieces (island/file-actions.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const {
  COMPACT_MAX_W, COMPACT_W, DEFAULT_DROP_TILES, DEFAULT_SHAPE, DROP_ACTION_IDS, DROP_FEATURE, DROP_GEOMETRY,
  EXPANDED_W, MAX_DROP_TILES, PANEL_H, TAB_BOT, TAB_WIDTH, TABS_MAX_H, TABS_MIN_H, VIEW_LAYOUTS, botPosition,
  compactWidth, dropTargetsGeometry, dropTileAt, dropZoneAt, expandedWidth, hidesHeader, islandSize, tabsIslandHeight,
} = await import("../src/core/layout.ts");
const {
  DROP_ACTIONS, RESIZE_PRESETS, baseName, chooseDropTiles, dirName, dropAction, errorText, fileActionProgress,
  fileActionText, fileKindOfMime, fileKindOfName, filesState, movedState, reduceFileAction, shortName,
} = await import("../src/island/file-actions.ts");

// ── Geometry and hit test ─────────────────────────────────────────────────────

/** Every point of the island, on a 2 px grid. */
function* islandPoints(g) {
  for (let x = 0; x <= g.w; x += 2) for (let y = 0; y <= g.h; y += 2) yield [x, y];
}

function inside(r, x, y) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

for (const mode of ["grid", "row"]) {
  // The grid takes every count a drag can show; one row only up to four.
  for (const n of mode === "grid" ? [2, 3, 4, 5, 6] : [2, 3, 4]) {
    test(`${mode}, ${n} tiles: inside the island, apart, and Mochi's column is free`, () => {
      const g = dropTargetsGeometry(n, mode);
      assert.equal(g.tiles.length, n);
      for (const r of g.tiles) {
        assert.ok(r.x >= 10 && r.y >= 8 && r.x + r.w <= g.w - 10 + 0.01 && r.y + r.h <= g.h - 10 + 0.01, JSON.stringify(r));
        // Mochi (a box) never sits on a tile.
        const half = g.bot.diameter / 2;
        const clear = g.bot.cx + half <= r.x || g.bot.cx - half >= r.x + r.w;
        assert.ok(clear, `Mochi overlaps ${JSON.stringify(r)}`);
      }
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = g.tiles[i];
          const b = g.tiles[j];
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          assert.ok(apart, `tiles ${i} and ${j} overlap`);
        }
      }
      // A step up from the 288×32 compact bar, inside the window's 720×320.
      assert.ok(g.w > 288 && g.w <= 680 && g.h > 32 && g.h <= 230, `${g.w}×${g.h}`);
    });

    test(`${mode}, ${n} tiles: every point of the island picks a tile, its own inside it`, () => {
      const g = dropTargetsGeometry(n, mode);
      const hit = new Set();
      for (const [x, y] of islandPoints(g)) {
        const i = dropTileAt(x, y, g.tiles);
        assert.ok(i >= 0 && i < n);
        hit.add(i);
        const own = g.tiles.findIndex((r) => inside(r, x, y));
        if (own >= 0) assert.equal(i, own, `(${x}, ${y})`);
      }
      assert.equal(hit.size, n);
      // The island's left and right halves never cross: Mochi's column splits them.
      for (const [x, y] of islandPoints(g)) {
        const r = g.tiles[dropTileAt(x, y, g.tiles)];
        if (x < g.bot.cx - 1) assert.ok(r.x < g.bot.cx, `(${x}, ${y}) went right`);
        if (x > g.bot.cx + 1) assert.ok(r.x > g.bot.cx, `(${x}, ${y}) went left`);
      }
    });
  }
}

test("two tiles: left half converts, right half moves to the workspace", () => {
  const g = dropTargetsGeometry(2);
  assert.equal(dropTileAt(1, 1, g.tiles), 0);
  assert.equal(dropTileAt(g.w / 2 - 2, g.h - 1, g.tiles), 0);
  assert.equal(dropTileAt(g.w / 2 + 2, 0, g.tiles), 1);
  assert.equal(dropTileAt(g.w, g.h, g.tiles), 1);
  // Outside the island too (the pointer a little off the edge).
  assert.equal(dropTileAt(-30, 200, g.tiles), 0);
  assert.equal(dropTileAt(g.w + 30, -5, g.tiles), 1);
});

test("four tiles in the 2×2 grid: corners pick their own, top row then bottom row", () => {
  const g = dropTargetsGeometry(4, "grid");
  assert.equal(dropTileAt(0, 0, g.tiles), 0);
  assert.equal(dropTileAt(g.w, 0, g.tiles), 1);
  assert.equal(dropTileAt(0, g.h, g.tiles), 2);
  assert.equal(dropTileAt(g.w, g.h, g.tiles), 3);
});

test("three tiles in the grid: the lone right tile spans the full height", () => {
  const g = dropTargetsGeometry(3, "grid");
  const [a, b, c] = g.tiles;
  assert.equal(b.x > a.x, true);
  assert.equal(c.x, a.x);
  assert.equal(b.y, a.y);
  assert.equal(b.y + b.h, c.y + c.h);
  assert.equal(dropTileAt(g.w, g.h, g.tiles), 1);
});

test("four tiles in a row: 660 wide, two each side of Mochi", () => {
  const g = dropTargetsGeometry(4, "row");
  assert.equal(g.w, 660);
  assert.equal(g.bot.cx, g.w / 2);
  assert.deepEqual([0, 165, 330 - 1, 330 + 1, 520, 660].map((x) => dropTileAt(x, 50, g.tiles)), [0, 1, 1, 2, 3, 3]);
});

test("the actions are in one list, zone ids come from the tiles shown", () => {
  assert.deepEqual(DROP_ACTIONS.map((a) => a.id), [...DROP_ACTION_IDS]);
  for (const a of DROP_ACTIONS) assert.ok(a.title && a.icon && DROP_FEATURE[a.id], a.id);
  assert.deepEqual([...DEFAULT_DROP_TILES], ["convert", "zip", "resize", "workspace"]);
  const g = DROP_GEOMETRY;
  assert.equal(dropZoneAt(0, 0), "convert");
  assert.equal(dropZoneAt(g.w, g.h), "workspace");
  // Two tiles: the left half, the right half.
  const two = dropTargetsGeometry(2);
  assert.equal(dropZoneAt(1, 1, ["unzip", "workspace"]), "unzip");
  assert.equal(dropZoneAt(two.w, two.h, ["unzip", "workspace"]), "workspace");
  // Six: corners pick the first and the last.
  const six = ["merge", "split", "rotate", "compress", "zip", "workspace"];
  const g6 = dropTargetsGeometry(6);
  assert.equal(dropZoneAt(0, 0, six), "merge");
  assert.equal(dropZoneAt(g6.w, g6.h, six), "workspace");
  assert.equal(dropZoneAt(0, 0, []), null);
});

// ── Which tiles a drag shows ──────────────────────────────────────────────────

test("kinds from names and from the MIME types of a drag", () => {
  assert.equal(fileKindOfName("C:\\Users\\me\\clip.MP4"), "video");
  assert.equal(fileKindOfName("/home/me/song.flac"), "audio");
  assert.equal(fileKindOfName("photo.HEIC"), "image");
  assert.equal(fileKindOfName("report.pdf"), "pdf");
  assert.equal(fileKindOfName("archive.zip"), "zip");
  assert.equal(fileKindOfName("/home/me/Projects/"), "folder");
  assert.equal(fileKindOfName("/home/me/Projects"), "folder");
  assert.equal(fileKindOfName("notes.txt"), "other");
  assert.equal(fileKindOfName(".bashrc"), "other");
  assert.equal(fileKindOfMime("image/png"), "image");
  assert.equal(fileKindOfMime("video/mp4"), "video");
  assert.equal(fileKindOfMime("audio/mpeg"), "audio");
  assert.equal(fileKindOfMime("application/pdf"), "pdf");
  assert.equal(fileKindOfMime("application/x-zip-compressed"), "zip");
  assert.equal(fileKindOfMime(""), "other");
});

test("the tiles fit what is dragged", () => {
  assert.deepEqual(chooseDropTiles(["video"]), ["convert", "zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["audio", "audio"]), ["convert", "zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["video", "audio"]), ["convert", "zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["image", "image"]), ["convert", "resize", "images", "zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["pdf"]), ["split", "rotate", "compress", "zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["pdf", "pdf"]), ["merge", "split", "rotate", "compress", "zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["zip"]), ["unzip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["folder"]), ["zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["other"]), ["zip", "workspace"]);
  assert.deepEqual(chooseDropTiles([]), ["zip", "workspace"]);
  // A mix: Zip and Workspace, with Convert when it is all media.
  assert.deepEqual(chooseDropTiles(["pdf", "image"]), ["zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["zip", "folder"]), ["zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["image", "video"]), ["convert", "zip", "workspace"]);
});

test("every choice shows 2 to 6 tiles, Workspace last", () => {
  const kinds = ["image", "video", "audio", "pdf", "zip", "folder", "other"];
  for (const a of kinds) {
    for (const b of [null, ...kinds]) {
      for (const n of [1, 2, 5]) {
        const list = Array.from({ length: n }, (_, i) => (i % 2 && b ? b : a));
        const tiles = chooseDropTiles(list);
        assert.ok(tiles.length >= 2 && tiles.length <= MAX_DROP_TILES, `${list}: ${tiles}`);
        assert.equal(tiles.at(-1), "workspace");
        assert.equal(new Set(tiles).size, tiles.length);
      }
    }
  }
});

test("switched-off features leave their tiles out", () => {
  assert.deepEqual(chooseDropTiles(["image"], ["convert", "pdf"]), ["resize", "zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["pdf", "pdf"], ["pdf"]), ["zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["zip"], ["zip"]), ["workspace"]);
  assert.deepEqual(chooseDropTiles(["video"], ["zip", "workspace"]), ["convert"]);
  assert.deepEqual(chooseDropTiles(["other"], ["zip", "workspace"]), []);
});

test("the drop targets view: its own width and height, no header, Mochi in the middle", () => {
  const g = DROP_GEOMETRY;
  assert.deepEqual(islandSize("expanded", "dropTargets"), { w: g.w, h: g.h });
  assert.equal(expandedWidth("dropTargets"), g.w);
  assert.ok(g.w < EXPANDED_W + 30);
  assert.equal(hidesHeader("dropTargets"), true);
  assert.equal(hidesHeader("fileAction"), false);
  const p = botPosition("expanded", "dropTargets", g.h);
  assert.equal(p.cx, g.w / 2);
  assert.equal(p.cy, g.bot.cy);
  // Every other view keeps the 640 wide cards, the file action card included.
  assert.deepEqual(islandSize("expanded", "fileAction"), { w: EXPANDED_W, h: VIEW_LAYOUTS.fileAction.height });
  assert.equal(islandSize("expanded", "overview").w, EXPANDED_W);
  assert.deepEqual(islandSize("compact", "dropTargets"), { w: 288, h: 32 });
  // Another number of tiles: its own geometry.
  const g6 = dropTargetsGeometry(6);
  const shape6 = { ...DEFAULT_SHAPE, dropCount: 6 };
  assert.deepEqual(islandSize("expanded", "dropTargets", shape6), { w: g6.w, h: g6.h });
  assert.equal(botPosition("expanded", "dropTargets", g6.h, shape6).cy, g6.bot.cy);
});

// ── Compact width and tabs ────────────────────────────────────────────────────

test("the compact island grows symmetrically to fit its sides, up to a limit", () => {
  assert.equal(compactWidth(0, 0), COMPACT_W);
  assert.equal(compactWidth(40, 30), COMPACT_W);
  const w = compactWidth(180, 60);
  assert.ok(w > COMPACT_W && w % 2 === 0, String(w));
  assert.equal(compactWidth(60, 180), w);
  assert.equal(compactWidth(5000, 0), COMPACT_MAX_W);
  assert.deepEqual(islandSize("compact", "overview", { ...DEFAULT_SHAPE, compactW: w }), { w, h: 32 });
  assert.equal(botPosition("compact", "overview", 32, { ...DEFAULT_SHAPE, compactW: w }).cx, w / 2);
});

test("a tab sizes the open island: 640 wide, its height clamped to the window", () => {
  assert.equal(TAB_WIDTH, EXPANDED_W);
  assert.equal(tabsIslandHeight(0), TABS_MIN_H);
  assert.equal(tabsIslandHeight(150), 202);
  assert.equal(tabsIslandHeight(420), 472);
  assert.equal(tabsIslandHeight(9999), TABS_MAX_H);
  assert.ok(TABS_MAX_H <= PANEL_H);
  assert.equal(tabsIslandHeight(NaN), TABS_MIN_H);
  const shape = { ...DEFAULT_SHAPE, tabsH: 240 };
  assert.deepEqual(islandSize("expanded", "overview", shape), { w: TAB_WIDTH, h: 240 });
  assert.equal(expandedWidth("overview", shape), TAB_WIDTH);
  // Mochi in the header's corner, the plain overview card's place otherwise.
  assert.deepEqual(botPosition("expanded", "overview", 240, shape), { ...TAB_BOT, opacity: 1 });
  assert.equal(botPosition("expanded", "overview", 160).cx, VIEW_LAYOUTS.overview.botX);
  // Other views keep their own size while a tab exists.
  assert.deepEqual(islandSize("expanded", "settings", shape), { w: EXPANDED_W, h: VIEW_LAYOUTS.settings.height });
});

// ── Names ─────────────────────────────────────────────────────────────────────

test("names: base name, folder, short names keep their extension", () => {
  assert.equal(baseName("C:\\Users\\me\\Notch Workspace"), "Notch Workspace");
  assert.equal(baseName("/home/me/ws/"), "ws");
  assert.equal(dirName("C:\\a\\b\\photo.png"), "C:\\a\\b");
  assert.equal(dirName("/tmp/x.mp4"), "/tmp");
  assert.equal(shortName("photo.png"), "photo.png");
  const long = shortName("an-incredibly-long-holiday-video-file-name-from-2026.mp4", 32);
  assert.equal([...long].length, 32);
  assert.ok(long.endsWith(".mp4") && long.includes("…"), long);
  assert.equal(errorText("Error: no such file"), "no such file");
  assert.equal(errorText("plain"), "plain");
});

// ── The card's state ──────────────────────────────────────────────────────────

const job = { id: 7, names: ["a.mov", "b.mov"], kind: "video", formats: [{ id: "mp4", label: "MP4" }] };
const format = job.formats[0];
const converting = { kind: "converting", job, format, index: 0, count: 2, fraction: 0 };

test("progress for this job moves the bar; another job's changes nothing", () => {
  const next = reduceFileAction(converting, { type: "progress", p: { id: 7, index: 1, count: 2, fraction: 0.6 } });
  assert.deepEqual(next, { ...converting, index: 1, fraction: 0.6 });
  assert.equal(reduceFileAction(converting, { type: "progress", p: { id: 8, index: 1, count: 2, fraction: 0.6 } }), converting);
  assert.equal(reduceFileAction(null, { type: "progress", p: { id: 7, index: 0, count: 1, fraction: 1 } }), null);
  const over = reduceFileAction(converting, { type: "progress", p: { id: 7, index: 0, count: 2, fraction: 3 } });
  assert.equal(over.fraction, 1);
});

test("convert-done: saved, failed, cancelled", () => {
  const done = reduceFileAction(converting, { type: "done", d: { id: 7, outputs: ["C:\\v\\a.mp4"], error: null, cancelled: false } });
  assert.deepEqual(done, { kind: "done", job, format, outputs: ["C:\\v\\a.mp4"] });
  const failed = reduceFileAction(converting, { type: "done", d: { id: 7, outputs: [], error: "Error: codec", cancelled: false } });
  assert.equal(failed.kind, "error");
  assert.equal(failed.message, "codec");
  assert.equal(reduceFileAction(converting, { type: "done", d: { id: 7, outputs: [], error: null, cancelled: true } }), null);
  // A late done for a card that moved on is ignored.
  const pick = { kind: "pick", job };
  assert.equal(reduceFileAction(pick, { type: "done", d: { id: 7, outputs: ["x"], error: null, cancelled: false } }), pick);
});

test("ffmpeg download: MB move on, done fills the bar, an error ends it", () => {
  const dl = { kind: "downloading", job, format, received: 0, total: 0 };
  const mid = reduceFileAction(dl, { type: "download", p: { received: 50_000_000, total: 115_000_000, done: false, error: null } });
  assert.equal(fileActionProgress(mid).toFixed(3), (50 / 115).toFixed(3));
  assert.equal(fileActionText(mid).sub, "50 MB of 115 MB");
  const done = reduceFileAction(mid, { type: "download", p: { received: 0, total: 0, done: true, error: null } });
  assert.equal(done.kind, "downloading");
  assert.equal(fileActionProgress(done), 1);
  const err = reduceFileAction(mid, { type: "download", p: { received: 0, total: 0, done: false, error: "offline" } });
  assert.equal(err.kind, "error");
  assert.equal(fileActionText({ ...dl }).sub, "0 MB");
});

test("the card's text in each state", () => {
  const moved = movedState({ dir: "C:\\Users\\me\\Notch Workspace", moved: ["C:\\Users\\me\\Notch Workspace\\photo.png"], failed: [] });
  assert.equal(fileActionText(moved).title, "Copied photo.png to Notch Workspace");
  assert.equal(fileActionText(moved).tone, "dim");
  const some = movedState({ dir: "/ws", moved: ["/ws/a", "/ws/b", "/ws/c"], failed: [{ name: "d", error: "in use" }] });
  assert.equal(fileActionText(some).title, "Copied 3 items to ws");
  assert.equal(fileActionText(some).sub, "1 couldn't be moved: in use");
  assert.equal(fileActionText(some).tone, "error");
  const none = movedState({ dir: "/ws", moved: [], failed: [{ name: "d.txt", error: "in use" }] });
  assert.equal(fileActionText(none).title, "Couldn't move d.txt");

  assert.equal(fileActionText({ kind: "pick", job: { ...job, names: ["photo.heic"], kind: "image" } }).title, "Convert photo.heic");
  assert.equal(fileActionText({ kind: "pick", job }).title, "Convert 2 videos");
  assert.equal(fileActionText({ kind: "pick", job }).sub, "Choose a format");
  assert.equal(fileActionText({ ...converting, index: 1, fraction: 0.5 }).title, "Converting b.mov → MP4");
  assert.equal(fileActionText({ ...converting, index: 1, fraction: 0.5 }).sub, "2 of 2 · 50 %");
  assert.equal(fileActionText({ kind: "done", job, format, outputs: ["/v/a.mp4"] }).title, "Saved a.mp4");
  assert.equal(fileActionText({ kind: "done", job, format, outputs: ["/v/a.mp4", "/v/b.mp4"] }).title, "Saved 2 files");
  assert.equal(fileActionText({ kind: "done", job, format, outputs: ["/v/a.mp4"] }).sub, "/v");
  assert.equal(fileActionText({ kind: "needsFfmpeg", job, format, canDownload: true }).title, "Converting needs ffmpeg");
  assert.equal(fileActionText({ kind: "soon", action: "zip" }).title, "Coming soon");
  assert.match(fileActionText({ kind: "soon", action: "resize" }).sub, /Resize image/);
  assert.equal(fileActionProgress({ kind: "pick", job }), null);

  // Resize, Zip, Unzip and the PDF actions.
  assert.equal(fileActionText({ kind: "resize", paths: ["C:\\p\\cat.png"] }).title, "Resize cat.png");
  assert.equal(fileActionText({ kind: "resize", paths: ["/a.png", "/b.png"] }).title, "Resize 2 images");
  assert.equal(fileActionText({ kind: "resize", paths: ["/a.png"] }).sub, "Choose a size");
  assert.deepEqual([...RESIZE_PRESETS], ["half", "1920", "1280", "800"]);
  const zipped = filesState("zip", { outputs: ["/w/stuff.zip"], failed: [] });
  assert.equal(zipped.kind, "written");
  assert.equal(fileActionText(zipped).title, "Saved stuff.zip");
  assert.equal(fileActionText(zipped).sub, "/w");
  const split = filesState("split", { outputs: ["/w/a-1.pdf", "/w/a-2.pdf"], failed: [{ name: "b.pdf", error: "locked" }] });
  assert.equal(fileActionText(split).title, "Saved 2 files");
  assert.equal(fileActionText(split).sub, "1 failed: locked");
  assert.equal(fileActionText(split).tone, "error");
  const nothing = filesState("merge", { outputs: [], failed: [{ name: "a.pdf", error: "encrypted" }] });
  assert.equal(fileActionText(nothing).title, `${dropAction("merge").title} failed`);
  assert.equal(fileActionText(nothing).sub, "encrypted");
  assert.equal(fileActionText(filesState("rotate", {})).sub, "No file was written.");
});
