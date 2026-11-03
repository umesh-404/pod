// The island's tabs (views/tabs/*), rendered with the fake DOM against the
// Tauri mock: what each one asks Rust for, and what it draws.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { internals, emit, sent, calls } from "./tauri.mjs";

installFakeDom();

const { shelfTab, shelfHeight, shelfColumns } = await import("../src/views/tabs/shelf.ts");
const { remindersTab, looksLikeDeadline, sortReminders } = await import("../src/views/tabs/reminders.ts");
const { notesTab, recentNotes } = await import("../src/views/tabs/notes.ts");
const { toolsTab, visibleTools, toolsHeight } = await import("../src/views/tabs/tools.ts");
const { middleEllipsis, formatCountdown } = await import("../src/views/tabs/common.ts");
const { State } = await import("../src/core/state.ts");

// ── Harness ───────────────────────────────────────────────────────────────────

/** Answers for commands, by name (a function gets the args). */
const answers = new Map();
const baseInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  if (cmd === "plugin:event|unlisten") return null;
  const r = await baseInvoke(cmd, args);
  if (!answers.has(cmd)) return r;
  const a = answers.get(cmd);
  return typeof a === "function" ? a(args) : a;
};
globalThis.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };

function makeHost() {
  const log = [];
  return {
    log,
    hold: (on) => log.push(`hold:${on}`),
    resize: () => log.push("resize"),
    close: () => log.push("close"),
    sound: (name) => log.push(`sound:${name}`),
  };
}

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function reset() {
  calls.length = 0;
  answers.clear();
}

/** Calls an element's listeners for `type` with an event carrying `extra`. */
function fire(el, type, extra = {}) {
  const event = {
    type,
    button: 0,
    buttons: 1,
    clientX: 0,
    clientY: 0,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
    ...extra,
  };
  for (const fn of el.listeners.get(type) ?? []) fn(event);
  return event;
}

const T = Date.UTC(2026, 10, 3, 12, 0, 0);
const item = (name, extra = {}) => ({
  name,
  isDir: false,
  size: 2048,
  modified: T,
  ext: name.includes(".") ? name.split(".").pop() : "",
  ...extra,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

test("middle ellipsis keeps the extension", () => {
  assert.equal(middleEllipsis("short.png"), "short.png");
  const m = middleEllipsis("a-very-long-screenshot-name-2026-11-03.png", 20);
  assert.equal([...m].length, 20);
  assert.ok(m.endsWith(".png"));
  assert.ok(m.includes("…"));
});

test("countdowns", () => {
  assert.equal(formatCountdown(T + 12 * 60_000, T), "in 12 min");
  assert.equal(formatCountdown(T + 125 * 60_000, T), "in 2 h 05");
  assert.equal(formatCountdown(T + 50 * 3_600_000, T), "in 2 d 2 h");
  assert.equal(formatCountdown(T - 1, T), "Overdue");
});

// ── Shelf ─────────────────────────────────────────────────────────────────────

test("shelf: heights stay in 160–420 and follow the rows", () => {
  assert.equal(shelfColumns(640), 6);
  assert.equal(shelfHeight(0), 160);
  assert.ok(shelfHeight(6) <= shelfHeight(7));
  assert.equal(shelfHeight(500), 420);
});

test("shelf: lists items, lazy thumbnails, live updates, empty state", async () => {
  reset();
  answers.set("shelf_list", [item("b.txt", { modified: T - 1000 }), item("a.png"), item("docs", { isDir: true, ext: "" })]);
  answers.set("shelf_thumb", "data:image/png;base64,AAAA");
  const host = makeHost();
  const tab = shelfTab(host);
  tab.show();
  await settle();

  const tiles = tab.el.find(".shelf-tile");
  assert.equal(tiles.length, 3);
  // Newest first.
  assert.equal(tiles[0].getAttribute("data-name"), "a.png");
  assert.equal(tab.el.querySelector(".tab-count").textContent, "3 items");
  // Only the image asked for a thumbnail, in physical pixels.
  assert.deepEqual(sent("shelf_thumb"), [{ name: "a.png", size: 64 }]);
  assert.ok(tiles[0].querySelector(".shelf-img"));
  assert.equal(tiles[0].getAttribute("draggable"), "false");

  // Live: the list changes.
  emit("shelf-changed", [item("a.png")]);
  assert.equal(tab.el.find(".shelf-tile").length, 1);
  // Cached: no second thumbnail call for the same name and time.
  assert.equal(sent("shelf_thumb").length, 1);

  emit("shelf-changed", []);
  assert.ok(tab.el.classList.contains("is-empty"));
  assert.match(tab.el.querySelector(".tab-empty-text").textContent, /Drop files on the notch/);
  assert.equal(tab.height(), 160);
  tab.hide();
});

test("shelf: click, Ctrl and Shift select; Delete recycles; double-click opens", async () => {
  reset();
  answers.set("shelf_list", ["1.txt", "2.txt", "3.txt", "4.txt"].map((n, i) => item(n, { modified: T - i })));
  const tab = shelfTab(makeHost());
  tab.show();
  await settle();
  const [t1, t2, t3, t4] = tab.el.find(".shelf-tile");
  const grid = tab.el.querySelector(".shelf-grid");

  fire(t1, "click");
  fire(t3, "click", { shiftKey: true });
  assert.deepEqual([t1, t2, t3, t4].map((t) => t.classList.contains("selected")), [true, true, true, false]);
  fire(t2, "click", { ctrlKey: true });
  assert.deepEqual([t1, t2, t3, t4].map((t) => t.classList.contains("selected")), [true, false, true, false]);

  fire(grid, "keydown", { key: "Delete" });
  await settle();
  assert.deepEqual(sent("shelf_remove"), [{ names: ["1.txt", "3.txt"] }]);

  fire(t4, "dblclick");
  await settle();
  assert.deepEqual(sent("shelf_open"), [{ name: "4.txt" }]);
  tab.hide();
});

test("shelf: a press that moves starts the native drag and holds the island", async () => {
  reset();
  answers.set("shelf_list", [item("x.png"), item("y.png", { modified: T - 5 })]);
  let finish;
  answers.set("shelf_drag", () => new Promise((r) => (finish = r)));
  const host = makeHost();
  const tab = shelfTab(host);
  tab.show();
  await settle();
  const [x] = tab.el.find(".shelf-tile");

  const down = fire(x, "pointerdown", { clientX: 10, clientY: 10 });
  assert.ok(down.defaultPrevented);
  fire(x, "pointermove", { clientX: 11, clientY: 11 });
  assert.equal(sent("shelf_drag").length, 0);
  fire(x, "pointermove", { clientX: 16, clientY: 10 });
  assert.deepEqual(sent("shelf_drag"), [{ names: ["x.png"] }]);
  assert.ok(host.log.includes("hold:true"));
  // Only once per press.
  fire(x, "pointermove", { clientX: 30, clientY: 10 });
  assert.equal(sent("shelf_drag").length, 1);

  await settle();
  finish(null);
  await settle();
  assert.equal(host.log.at(-1), "hold:false");
  assert.ok(fire(x, "dragstart").defaultPrevented);
  tab.hide();
});

// ── Reminders ─────────────────────────────────────────────────────────────────

test("reminders: deadline words, order", () => {
  assert.ok(looksLikeDeadline("Submit the report by Friday"));
  assert.ok(looksLikeDeadline("maths exam at 9"));
  assert.ok(!looksLikeDeadline("call Sam at 4pm"));
  const sorted = sortReminders([
    { id: 1, text: "a", due: 3, fired: false, deadline: false },
    { id: 2, text: "b", due: 9, fired: true, deadline: false },
    { id: 3, text: "c", due: 1, fired: false, deadline: true },
  ]);
  assert.deepEqual(sorted.map((r) => r.id), [2, 3, 1]);
});

test("reminders: list, live preview, Enter adds as a deadline", async () => {
  reset();
  const due = Date.now() + 2 * 3_600_000;
  answers.set("reminders_list", [
    { id: 1, text: "Stand-up", due: Date.now() + 60_000, fired: false, deadline: false },
    { id: 2, text: "Water the plants", due: Date.now() - 60_000, fired: true, deadline: false },
    { id: 3, text: "Essay", due, fired: false, deadline: true },
  ]);
  answers.set("reminder_parse", ({ input }) => ({ text: input.replace(/ by .*/, ""), due }));
  answers.set("reminder_add", ({ text, due, deadline }) => ({ id: 9, text, due, deadline, fired: false }));
  const host = makeHost();
  const tab = remindersTab(host);
  tab.show();
  await settle();

  const rows = tab.el.find(".rem-row");
  assert.equal(rows.length, 3);
  assert.ok(rows[0].classList.contains("fired"));
  assert.equal(rows[0].find("BUTTON").length, 3); // Done, 10 min, 1 h
  assert.match(tab.el.querySelector(".countdown").textContent, /^in (1 h 5\d|2 h 00)$/);

  // Snooze 10 minutes.
  fire(rows[0].find("BUTTON")[1], "click");
  await settle();
  assert.deepEqual(sent("reminder_snooze"), [{ id: 2, minutes: 10 }]);

  const input = tab.el.querySelector(".rem-input");
  // Typing doesn't hold the island: it folds when the pointer leaves and picks up again.
  fire(input, "focus");
  assert.ok(!host.log.includes("hold:true"));
  input.value = "Submit essay by 5pm";
  fire(input, "input");
  assert.ok(tab.el.querySelector(".rem-seg").classList.contains("right"), "a deadline by default");

  fire(input, "keydown", { key: "Enter" });
  await settle(10);
  assert.deepEqual(sent("reminder_add"), [{ text: "Submit essay", due, deadline: true }]);
  assert.equal(input.value, "");
  assert.ok(host.log.includes("sound:pop"));

  // No time: nothing is added.
  answers.set("reminder_parse", ({ input }) => ({ text: input, due: null }));
  input.value = "something";
  fire(input, "input");
  fire(input, "keydown", { key: "Enter" });
  await settle(10);
  assert.equal(sent("reminder_add").length, 1);
  assert.match(tab.el.querySelector(".rem-preview-text").textContent, /Add a time/);

  tab.hide();
});

// ── Notes ─────────────────────────────────────────────────────────────────────

test("notes: recent notes are the shelf's .md files", () => {
  const list = recentNotes([item("a.md", { modified: 1 }), item("b.MD", { modified: 3 }), item("c.txt"), item("d.md", { isDir: true })]);
  assert.deepEqual(list.map((i) => i.name), ["b.MD", "a.md"]);
});

test("notes: the first save creates the file, then it is rewritten; opening a note", async () => {
  reset();
  answers.set("shelf_list", [item("Old note.md")]);
  answers.set("note_save", ({ name }) => name ?? "Note 2026-11-03.md");
  answers.set("note_read", "# Old\n");
  const host = makeHost();
  const tab = notesTab(host);
  tab.show();
  await settle();
  assert.equal(tab.el.find(".note-chip").length, 1);

  const area = tab.el.querySelector(".note-area");
  fire(area, "focus");
  area.value = "first line";
  fire(area, "input");
  fire(area, "blur");
  await settle();
  area.value = "first line\nsecond";
  fire(area, "input");
  fire(area, "blur");
  await settle();
  assert.deepEqual(sent("note_save"), [
    { name: null, text: "first line" },
    { name: "Note 2026-11-03.md", text: "first line\nsecond" },
  ]);
  assert.equal(tab.el.querySelector(".note-status-text").textContent, "Saved to shelf");

  fire(tab.el.find(".note-chip")[0], "click");
  await settle();
  assert.deepEqual(sent("note_read"), [{ name: "Old note.md" }]);
  assert.equal(area.value, "# Old\n");

  // An empty new note writes nothing.
  fire(tab.el.querySelector(".tab-link"), "click");
  await settle();
  assert.equal(area.value, "");
  fire(area, "input");
  fire(area, "blur");
  await settle();
  assert.equal(sent("note_save").length, 2);
  tab.hide();
});

// ── Tools ─────────────────────────────────────────────────────────────────────

test("tools: cards follow disabledFeatures; heights", () => {
  assert.deepEqual(visibleTools([]), ["capture", "focus", "clipboard", "devservers"]);
  assert.deepEqual(visibleTools(["capture", "devservers"]), ["focus", "clipboard"]);
  assert.equal(toolsHeight([]), 160);
  assert.ok(toolsHeight(["capture", "focus", "clipboard", "devservers"]) <= 420);
});

test("tools: clipboard readings, copy, dev servers, capture folds first", async () => {
  reset();
  State.settings = { ...State.settings, disabledFeatures: ["focus"] };
  answers.set("clipboard_text", '{"a":1}');
  answers.set("devservers_now", [{ port: 5173, pid: 4, process: "node", url: "http://localhost:5173" }]);
  answers.set("capture_to_shelf", "C:\\Pod\\Screenshot 1.png");
  const host = makeHost();
  const tab = toolsTab(host);
  tab.show();
  await settle();

  const cards = tab.el.find(".tool-card");
  assert.deepEqual(cards.map((c) => c.getAttribute("data-tool")), ["capture", "clipboard", "devservers"]);
  assert.equal(tab.el.querySelector(".clip-label").textContent, "JSON");
  assert.equal(tab.el.querySelector(".clip-out").textContent, '{\n  "a": 1\n}');
  fire(tab.el.querySelector(".clip-row").find("BUTTON")[0], "click");
  await settle();
  assert.deepEqual(sent("clipboard_set_text"), [{ text: '{\n  "a": 1\n}' }]);

  assert.deepEqual(sent("devservers_watch"), [{ on: true }]);
  assert.equal(tab.el.querySelector(".server-port").textContent, ":5173");
  emit("dev-servers", []);
  assert.match(tab.el.querySelector(".server-list").textContent, /No dev servers/);

  fire(tab.el.querySelector(".tool-capture").find("BUTTON")[0], "click");
  assert.equal(host.log[0], "close");
  await settle();
  assert.match(tab.el.querySelector(".tool-toast").textContent, /Screenshot 1\.png/);

  tab.hide();
  assert.deepEqual(sent("devservers_watch").at(-1), { on: false });
  State.settings = { ...State.settings, disabledFeatures: [] };
});

test("tools: nothing special on the clipboard; focus card starts the timer", async () => {
  reset();
  answers.set("clipboard_text", "just words");
  const tab = toolsTab(makeHost());
  tab.show();
  await settle();
  assert.match(tab.el.querySelector(".clip-list").textContent, /Nothing special on the clipboard/);
  const focus = tab.el.querySelector(".tool-focus");
  assert.ok(focus.classList.contains("phase-off"));
  fire(focus.find("BUTTON")[0], "click");
  assert.ok(focus.classList.contains("phase-focus"));
  // Stop again so no timer outlives the test.
  fire(focus.find("BUTTON")[0], "click");
  assert.ok(focus.classList.contains("phase-off"));
  tab.hide();
});
