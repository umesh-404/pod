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
  fileActionText, fileKindOfMime, fileKindOfName, filesState, findSha256, hashCopyText, hashVerdict, movedState,
  reduceFileAction, shortName, textState, unavailableActions,
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
  // The grid takes every count a drag can show (one tile when the others are
  // switched off, up to MAX_DROP_TILES); one row only up to four.
  const counts = mode === "grid" ? Array.from({ length: MAX_DROP_TILES }, (_, i) => i + 1) : [2, 3, 4];
  for (const n of counts) {
    test(`${mode}, ${n} tiles: inside the island, apart, and Stew's column is free`, () => {
      const g = dropTargetsGeometry(n, mode);
      assert.equal(g.tiles.length, n);
      for (const r of g.tiles) {
        assert.ok(r.x >= 10 && r.y >= 8 && r.x + r.w <= g.w - 10 + 0.01 && r.y + r.h <= g.h - 10 + 0.01, JSON.stringify(r));
        // Whole tiles: a positive size, never thinner than the flat layout's 58 px.
        assert.ok(r.w >= 137 && r.h >= 58, JSON.stringify(r));
        // Stew never sits on a tile.
        const half = g.bot.diameter / 2;
        const clear = g.bot.cx + half <= r.x || g.bot.cx - half >= r.x + r.w;
        assert.ok(clear, `Stew overlaps ${JSON.stringify(r)}`);
      }
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = g.tiles[i];
          const b = g.tiles[j];
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          assert.ok(apart, `tiles ${i} and ${j} overlap`);
        }
      }
      // A step up from the 288×32 compact bar, well inside the 720-wide window.
      assert.ok(g.w > 288 && g.w <= 680 && g.h > 32 && g.h <= Math.min(PANEL_H, 280), `${g.w}×${g.h}`);
      // Equal insets: the grid's tiles touch 10 px from both sides and 8 px / 10 px from top and bottom.
      const left = Math.min(...g.tiles.map((r) => r.x));
      const right = Math.max(...g.tiles.map((r) => r.x + r.w));
      const top = Math.min(...g.tiles.map((r) => r.y));
      const bottom = Math.max(...g.tiles.map((r) => r.y + r.h));
      assert.equal(left, 10);
      assert.equal(top, 8);
      assert.ok(Math.abs(g.h - 10 - bottom) < 0.01, `bottom inset ${g.h - bottom}`);
      if (n > 1) assert.ok(Math.abs(g.w - 10 - right) < 0.01, `right inset ${g.w - right}`);
      // Each column fills the full height, its tiles 8 px apart.
      for (const x of new Set(g.tiles.map((r) => r.x))) {
        const col = g.tiles.filter((r) => r.x === x).sort((a, b) => a.y - b.y);
        assert.ok(Math.abs(col[0].y - 8) < 0.01 && Math.abs(col.at(-1).y + col.at(-1).h - bottom) < 0.01);
        for (let i = 1; i < col.length; i++) assert.ok(Math.abs(col[i].y - (col[i - 1].y + col[i - 1].h) - 8) < 0.01);
      }
      // Stew sits inside the island, between the columns, with room around him.
      assert.ok(g.bot.cx - g.bot.diameter / 2 >= 0 && g.bot.cx + g.bot.diameter / 2 <= g.w);
      assert.ok(g.bot.cy - g.bot.diameter / 2 >= 0 && g.bot.cy + g.bot.diameter / 2 <= g.h);
      // One look per layout: the grid puts every icon beside its text, the row above it.
      assert.equal(g.flat, mode === "grid" && n > 2);
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
      // The island's left and right halves never cross: Stew's column splits them.
      if (n === 1) return;
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

test("four tiles in a row: 660 wide, two each side of Stew", () => {
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
  // Videos: GIF and Compress video; images: Text, Remove EXIF (SHA-256 gives way, 8 at most).
  assert.deepEqual(chooseDropTiles(["video"]), ["convert", "gif", "share", "rename", "sha256", "zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["audio", "audio"]), ["convert", "rename", "sha256", "zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["video", "audio"]), ["convert", "rename", "sha256", "zip", "workspace"]);
  assert.deepEqual(
    chooseDropTiles(["image", "image"]),
    ["convert", "ocr", "resize", "clean", "pages", "rename", "zip", "workspace"],
  );
  assert.deepEqual(chooseDropTiles(["pdf"]), ["pages", "split", "rotate", "compress", "rename", "sha256", "zip", "workspace"]);
  assert.deepEqual(
    chooseDropTiles(["pdf", "pdf"]),
    ["merge", "pages", "split", "compress", "rename", "sha256", "zip", "workspace"],
  );
  assert.deepEqual(chooseDropTiles(["zip"]), ["unzip", "rename", "sha256", "workspace"]);
  // A folder can't be hashed.
  assert.deepEqual(chooseDropTiles(["folder"]), ["rename", "zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["other"]), ["rename", "sha256", "zip", "workspace"]);
  assert.deepEqual(chooseDropTiles([]), ["rename", "sha256", "zip", "workspace"]);
  // A mix: the actions for any file, with Convert when it is all media, the PDF editor for pictures and PDFs.
  assert.deepEqual(chooseDropTiles(["pdf", "image"]), ["pages", "rename", "sha256", "zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["zip", "folder"]), ["rename", "zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["image", "video"]), ["convert", "rename", "sha256", "zip", "workspace"]);
  // An image with a tile switched off: SHA-256 comes back in its place.
  assert.deepEqual(
    chooseDropTiles(["image"], ["resize"]),
    ["convert", "ocr", "clean", "pages", "images", "rename", "zip", "workspace"],
  );
});

test("an action this system can't do is left out (no OCR on Linux)", () => {
  assert.deepEqual(unavailableActions("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15"), ["ocr"]);
  assert.deepEqual(unavailableActions("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/131"), []);
  assert.deepEqual(unavailableActions("Node.js/22"), []);
  const linux = chooseDropTiles(["image"], [], ["ocr"]);
  assert.ok(!linux.includes("ocr"));
  assert.deepEqual(linux, ["convert", "resize", "clean", "pages", "images", "rename", "zip", "workspace"]);
});

test("every choice shows 2 to MAX_DROP_TILES tiles, Workspace last", () => {
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
  assert.deepEqual(
    chooseDropTiles(["image"], ["convert", "pdf"]),
    ["ocr", "resize", "clean", "pages", "rename", "sha256", "zip", "workspace"],
  );
  assert.deepEqual(chooseDropTiles(["pdf", "pdf"], ["pdf"]), ["pages", "rename", "sha256", "zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["zip"], ["zip"]), ["rename", "sha256", "workspace"]);
  assert.deepEqual(chooseDropTiles(["video"], ["zip", "workspace", "gif"]), ["convert", "share", "rename", "sha256"]);
  assert.deepEqual(chooseDropTiles(["image"], ["ocr", "clean", "rename", "sha256"]), ["convert", "resize", "pages", "images", "zip", "workspace"]);
  assert.deepEqual(chooseDropTiles(["zip"], ["zip", "rename", "sha256"]), ["workspace"]);
  assert.deepEqual(chooseDropTiles(["other"], ["zip", "workspace", "rename", "sha256"]), []);
  // Every new action has its own switch.
  for (const id of ["ocr", "clean", "gif", "share", "sha256", "rename"]) assert.equal(DROP_FEATURE[id], id);
});

test("every count of tiles a drag can show has a geometry, its tiles in place", () => {
  const kinds = ["image", "video", "audio", "pdf", "zip", "folder", "other"];
  const switches = [[], ["convert"], ["pdf", "zip"], ["rename", "sha256"], ["workspace", "zip", "rename"], ["ocr", "clean", "gif", "share"]];
  const seen = new Set();
  for (const a of kinds) {
    for (const b of [null, ...kinds]) {
      for (const off of switches) {
        const tiles = chooseDropTiles(b ? [a, b] : [a, a], off);
        if (tiles.length === 0) continue;
        seen.add(tiles.length);
        const g = dropTargetsGeometry(tiles.length);
        assert.equal(g.tiles.length, tiles.length);
        // The zone under each tile's centre is that tile.
        g.tiles.forEach((r, i) => assert.equal(dropZoneAt(r.x + r.w / 2, r.y + r.h / 2, tiles), tiles[i]));
      }
    }
  }
  assert.ok(Math.max(...seen) <= MAX_DROP_TILES && seen.has(MAX_DROP_TILES) && seen.has(1), [...seen].join(","));
});

test("the drop targets view: its own width and height, no header, Stew in the middle", () => {
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
  // Stew in the header's corner, the plain overview card's place otherwise.
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
  assert.equal(fileActionText(moved).title, "Copied photo.png to the shelf");
  assert.equal(fileActionText(moved).tone, "dim");
  const some = movedState({ dir: "/ws", moved: ["/ws/a", "/ws/b", "/ws/c"], failed: [{ name: "d", error: "in use" }] });
  assert.equal(fileActionText(some).title, "Copied 3 items to the shelf");
  assert.equal(fileActionText(some).sub, "1 couldn't be moved: in use");
  assert.equal(fileActionText(some).tone, "error");
  const none = movedState({ dir: "/ws", moved: [], failed: [{ name: "d.txt", error: "in use" }] });
  assert.equal(fileActionText(none).title, "Couldn't move d.txt");

  assert.equal(fileActionText({ kind: "pick", job: { ...job, names: ["photo.heic"], kind: "image" } }).title, "Convert photo.heic");
  assert.equal(fileActionText({ kind: "pick", job }).title, "Convert 2 videos");
  assert.equal(fileActionText({ kind: "pick", job }).sub, "Choose a format");
  assert.equal(fileActionText({ ...converting, index: 1, fraction: 0.5 }).title, "Converting b.mov → MP4");
  assert.equal(fileActionText({ ...converting, index: 1, fraction: 0.5 }).sub, "2 of 2 · 50 %");
  // Saved onto the shelf: its name in the title, the full folder below.
  assert.equal(fileActionText({ kind: "done", job, format, outputs: ["/v/a.mp4"] }).title, "Saved a.mp4 to the shelf");
  assert.equal(fileActionText({ kind: "done", job, format, outputs: ["/v/a.mp4", "/v/b.mp4"] }).title, "Saved 2 files to the shelf");
  assert.equal(
    fileActionText({ kind: "done", job, format, outputs: ["C:\\Users\\me\\Notch Workspace\\clip.gif"] }).title,
    "Saved clip.gif to the shelf",
  );
  assert.equal(fileActionText({ kind: "done", job, format, outputs: ["a.mp4"] }).title, "Saved a.mp4 to the shelf");
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
  assert.equal(fileActionText(zipped).title, "Saved stuff.zip to the shelf");
  assert.equal(fileActionText(zipped).sub, "/w");
  const split = filesState("split", { outputs: ["/w/a-1.pdf", "/w/a-2.pdf"], failed: [{ name: "b.pdf", error: "locked" }] });
  assert.equal(fileActionText(split).title, "Saved 2 files to the shelf");
  assert.equal(fileActionText(split).sub, "1 failed: locked");
  assert.equal(fileActionText(split).tone, "error");
  const nothing = filesState("merge", { outputs: [], failed: [{ name: "a.pdf", error: "encrypted" }] });
  assert.equal(fileActionText(nothing).title, `${dropAction("merge").title} failed`);
  assert.equal(fileActionText(nothing).sub, "encrypted");
  assert.equal(fileActionText(filesState("rotate", {})).sub, "No file was written.");
});

// ── File tools: text, SHA-256, Remove EXIF, rename ──────────────────────────

test("a SHA-256 on the clipboard: alone, sha256sum style or prefixed; anything else is none", () => {
  const hex = "A".repeat(64);
  assert.equal(findSha256(hex), "a".repeat(64));
  assert.equal(findSha256(`  ${hex}  ubuntu.iso\n`), "a".repeat(64));
  assert.equal(findSha256(`SHA256: ${hex}`), "a".repeat(64));
  assert.equal(findSha256(`sha-256=${hex}`), "a".repeat(64));
  assert.equal(findSha256("a".repeat(63)), null);
  assert.equal(findSha256("g".repeat(64)), null);
  assert.equal(findSha256(`see ${hex}`), null);
  assert.equal(findSha256(""), null);
  assert.equal(findSha256(null), null);
  assert.equal(findSha256(`${hex}${" ".repeat(5000)}`), null, "not a hash, a document");
});

const H1 = { name: "a.iso", sha256: "1".repeat(64), size: 10 };
const H2 = { name: "b.iso", sha256: "2".repeat(64), size: 20 };

test("the hash card: progress, match, mismatch, nothing to compare", () => {
  const hashing = { kind: "hashing", id: 3, names: ["a.iso"], fraction: 0 };
  const mid = reduceFileAction(hashing, { type: "hash", p: { id: 3, fraction: 0.4 } });
  assert.equal(fileActionProgress(mid), 0.4);
  assert.equal(fileActionText(mid).sub, "40 %");
  assert.equal(fileActionText(mid).title, "SHA-256 of a.iso");
  assert.equal(reduceFileAction(mid, { type: "hash", p: { id: 4, fraction: 0.9 } }), mid, "another job");
  assert.equal(reduceFileAction(mid, { type: "hash", p: { id: 3, fraction: 0.1 } }).fraction, 0.4, "never backwards");

  assert.equal(hashVerdict([H1], "1".repeat(64)), "match");
  assert.equal(hashVerdict([H1, H2], "2".repeat(64)), "match");
  assert.equal(hashVerdict([H1], "3".repeat(64)), "mismatch");
  assert.equal(hashVerdict([H1], null), null);
  const match = { kind: "hashed", hashes: [H1], failed: [], expected: "1".repeat(64), copied: false };
  assert.equal(fileActionText(match).tone, "ok");
  assert.match(fileActionText(match).sub, /Matches/);
  const wrong = { ...match, expected: "9".repeat(64) };
  assert.equal(fileActionText(wrong).tone, "error");
  assert.match(fileActionText(wrong).sub, /Doesn't match/);
  const none = { ...match, expected: null };
  assert.equal(fileActionText(none).tone, "dim");
  assert.equal(fileActionText({ ...none, copied: true }).sub, "Copied");
  assert.equal(fileActionText({ ...none, hashes: [H1, H2] }).title, "SHA-256 of 2 files");
  assert.equal(fileActionProgress(match), null);
  assert.equal(hashCopyText([H1]), "1".repeat(64));
  assert.equal(hashCopyText([H1, H2]), `${"1".repeat(64)}  a.iso\n${"2".repeat(64)}  b.iso`);
});

test("the text card: copied, from one or several pictures, what failed", () => {
  const report = { text: "Hello", names: ["shot.png"], outputs: ["/ws/shot (text).txt"], failed: [], copied: true };
  const one = textState(report);
  assert.equal(one.kind, "text");
  assert.equal(fileActionText(one).title, "Copied the text from shot.png");
  assert.equal(fileActionText(one).sub, "");
  assert.equal(fileActionText({ ...one, copied: false }).title, "Text from shot.png");
  const two = textState({ ...report, names: ["a.png", "b.png"], failed: [{ name: "c.png", error: "No text" }] });
  assert.equal(fileActionText(two).title, "Copied the text from 2 pictures");
  assert.equal(fileActionText(two).tone, "error");
  assert.equal(textState({ ...report, text: "", names: [] }), null, "nothing read: the error card");
});

test("Remove EXIF: the clean copies, and whether there was anything to remove", () => {
  const cleaned = filesState("clean", { outputs: ["/ws/p (clean).jpg"], failed: [], cleaned: 1 });
  assert.equal(fileActionText(cleaned).title, "Saved p (clean).jpg to the shelf");
  assert.equal(fileActionText(cleaned).tone, "ok");
  const already = filesState("clean", { outputs: ["/ws/p (clean).png"], failed: [], cleaned: 0 });
  assert.equal(fileActionText(already).tone, "dim");
  assert.match(fileActionText(already).sub, /no location/);
  const broken = filesState("clean", { outputs: [], failed: [{ name: "a.gif", error: "not a JPEG" }], cleaned: 0 });
  assert.equal(fileActionText(broken).title, "Remove EXIF failed");
  // The other actions' reports have no `cleaned`.
  assert.equal("cleaned" in filesState("zip", { outputs: ["/w/a.zip"] }), false);
});

test("the rename card: hint, error, preview; renamed and put back", () => {
  const job = { id: 5, names: ["a.jpg", "b.jpg"] };
  const empty = { kind: "rename", job, pattern: "", rows: [], error: null };
  assert.equal(fileActionText(empty).title, "Rename 2 files");
  assert.match(fileActionText(empty).sub, /\{n\}/);
  assert.equal(fileActionText({ ...empty, job: { id: 5, names: ["a.jpg"] } }).title, "Rename a.jpg");
  const bad = { ...empty, pattern: "a/b", error: "A name can't contain /." };
  assert.deepEqual(fileActionText(bad), { title: "Rename 2 files", sub: "A name can't contain /.", tone: "error" });
  const fine = { ...empty, pattern: "Trip {n}", rows: [{ from: "a.jpg", to: "Trip 1.jpg" }] };
  assert.equal(fileActionText(fine).sub, "");

  const report = { renamed: [{ from: "a.jpg", to: "Trip 1.jpg" }, { from: "b.jpg", to: "Trip 2.jpg" }], unchanged: 0, failed: [] };
  const done = { kind: "renamed", id: 5, report, undone: false };
  assert.equal(fileActionText(done).title, "Renamed 2 files");
  assert.equal(fileActionText(done).sub, "a.jpg → Trip 1.jpg …");
  const single = { ...done, report: { ...report, renamed: report.renamed.slice(0, 1) } };
  assert.equal(fileActionText(single).title, "Renamed Trip 1.jpg");
  assert.equal(fileActionText(single).sub, "a.jpg → Trip 1.jpg");
  const back = { ...done, undone: true };
  assert.equal(fileActionText(back).title, "Put back 2 names");
  const partly = { ...done, report: { ...report, failed: [{ name: "Trip 2.jpg", error: "b.jpg is already taken." }] } };
  assert.equal(fileActionText(partly).tone, "error");
  const nothing = { ...done, report: { renamed: [], unchanged: 2, failed: [] } };
  assert.equal(fileActionText(nothing).title, "Nothing was renamed");
});

test("Video to GIF and Compress video show as conversions", () => {
  const gifJob = { id: 9, names: ["clip.mp4"], kind: "video", formats: [{ id: "gif", label: "GIF" }] };
  const s = { kind: "converting", job: gifJob, format: gifJob.formats[0], index: 0, count: 1, fraction: 0.25 };
  assert.equal(fileActionText(s).title, "Converting clip.mp4 → GIF");
  assert.equal(fileActionText(s).sub, "25 %");
  const done = reduceFileAction(s, { type: "done", d: { id: 9, outputs: ["/ws/clip (small).mp4"], error: null, cancelled: false } });
  assert.equal(fileActionText(done).title, "Saved clip (small).mp4 to the shelf");
  for (const id of ["gif", "share", "ocr", "clean", "sha256", "rename"]) {
    const a = dropAction(id);
    assert.ok(a.title && a.sub && a.icon, id);
  }
});

test("text dragged in offers only Save as note, and not when it's switched off", () => {
  assert.deepEqual(chooseDropTiles(["text"]), ["note"]);
  assert.deepEqual(chooseDropTiles(["text"], ["textnote"]), []);
});
