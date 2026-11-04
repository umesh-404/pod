// The PDF editor's page logic (src/studio/order.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CELL_RATIO, columns, defaultName, move, newPages, pagesOf, saveOrder, slotAt, turn, turnScale,
} from "../src/studio/order.ts";

const pdf = { id: 0, name: "Report.pdf", kind: "pdf", pages: [{ w: 595, h: 842 }, { w: 842, h: 595 }] };
const photo = { id: 1, name: "IMG_1.jpg", kind: "image", pages: [{ w: 4000, h: 3000 }] };

test("every page of every file, in order, each with a key of its own", () => {
  const pages = pagesOf([pdf, photo]);
  assert.deepEqual(pages.map((p) => p.key), ["0:0", "0:1", "1:0"]);
  assert.deepEqual(pages.map((p) => [p.source, p.page, p.turns]), [[0, 0, 0], [0, 1, 0], [1, 0, 0]]);
  assert.equal(pages[2].kind, "image");
});

test("moving a page keeps the others in order", () => {
  assert.deepEqual(move(["a", "b", "c", "d"], 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(move(["a", "b", "c", "d"], 3, 0), ["d", "a", "b", "c"]);
  assert.deepEqual(move(["a", "b", "c"], 1, 99), ["a", "c", "b"], "clamped to the end");
  assert.deepEqual(move(["a", "b", "c"], 5, 0), ["a", "b", "c"], "nothing at 5");
});

test("turns wrap around both ways", () => {
  const [p] = pagesOf([pdf]);
  assert.equal(turn(p, 1).turns, 1);
  assert.equal(turn(p, -1).turns, 3);
  assert.equal(turn(turn(turn(turn(p, 1), 1), 1), 1).turns, 0);
});

test("a page turned sideways is scaled to fit its 3:4 box", () => {
  assert.equal(CELL_RATIO, 0.75);
  assert.equal(turnScale(595, 842, 0), 1);
  assert.equal(turnScale(595, 842, 2), 1);
  // A portrait A4 page on its side: as wide as the box allows.
  const s = turnScale(595, 842, 1);
  const fit = (w, h) => Math.min(0.75 / w, 1 / h);
  assert.ok(Math.abs(s - fit(842, 595) / fit(595, 842)) < 1e-9);
  assert.ok(s < 1);
  assert.equal(turnScale(0, 0, 1), 1, "no size: left alone");
});

test("the default name comes from the first PDF, else the first picture", () => {
  assert.equal(defaultName([photo, pdf]), "Report (edited)");
  assert.equal(defaultName([photo]), "IMG_1 (pages)");
  assert.equal(defaultName([]), "PDF");
});

test("the slot under the pointer, else the nearest", () => {
  const slots = [
    { x: 0, y: 0, w: 100, h: 140 }, { x: 116, y: 0, w: 100, h: 140 },
    { x: 0, y: 158, w: 100, h: 140 },
  ];
  assert.equal(slotAt(slots, 50, 50), 0);
  assert.equal(slotAt(slots, 150, 100), 1);
  assert.equal(slotAt(slots, 108, 70), 0, "in the gap: nearest centre");
  assert.equal(slotAt(slots, 400, 400), 2, "past the end: the last row");
  assert.equal(slotAt([], 0, 0), -1);
  assert.equal(columns(slots), 2);
  assert.equal(columns([]), 1);
});

test("what is saved: each page's file, page and turns", () => {
  const pages = pagesOf([pdf, photo]);
  const order = move(pages, 2, 0).map((p, i) => (i === 0 ? turn(p, 1) : p));
  assert.deepEqual(saveOrder(order), [
    { source: 1, page: 0, turns: 1 }, { source: 0, page: 0, turns: 0 }, { source: 0, page: 1, turns: 0 },
  ]);
});

test("files added later only add their own pages", () => {
  const state = { session: 1, sources: [pdf, photo], failed: [] };
  assert.deepEqual(newPages(state, new Set([0])).map((p) => p.key), ["1:0"]);
  assert.deepEqual(newPages(state, new Set([0, 1])), []);
});
