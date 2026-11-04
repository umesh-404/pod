// Settings → Features and Settings → Notch: the rules behind their switches
// (src/settings/catalog.ts) and what the pages write when they are used.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { internals } from "./tauri.mjs";

installFakeDom();

const {
  FEATURE_GROUPS, FEATURE_IDS, RIGHT_IDS, SIDE_IDS, calendarLink, clampNumber, featureOn, moveRow, placeRow, rightRows,
  rightWidgetsOf, sideRows, sideSettingsKeeping, sideSettingsOf, withFeature, ROTATE_RANGE, FOCUS_RANGE, BREAK_RANGE,
} = await import("../src/settings/catalog.ts");
const { featuresSections } = await import("../src/settings/features.ts");
const { notchSections } = await import("../src/settings/notch.ts");
const { DEFAULT_SETTINGS } = await import("../src/core/state.ts");
const { setLanguage } = await import("../src/i18n/i18n.ts");

const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => setLanguage("en"));

/** A settings store like main.ts's: every write is kept. */
function store(initial = {}) {
  let settings = { ...DEFAULT_SETTINGS, ...initial };
  const writes = [];
  return {
    writes,
    access: {
      get: () => settings,
      set: (patch) => {
        settings = { ...settings, ...patch };
        writes.push(patch);
      },
    },
    get settings() {
      return settings;
    },
  };
}

// ── Catalog ──────────────────────────────────────────────────────────────────

test("every feature the island can switch off is listed once", () => {
  assert.deepEqual(
    [...FEATURE_IDS].sort(),
    [
      "capture", "clean", "clipboard", "convert", "devservers", "focus", "gif", "heal", "notes", "ocr", "pdf", "pdfstudio", "privacy",
      "reminders", "rename", "resize", "sha256", "share", "shelf", "textnote", "tools", "workspace", "zip",
    ],
  );
  assert.deepEqual(FEATURE_GROUPS.map((g) => g.anchor), ["features.drop", "features.tabs", "features.notch", "features.tools", "features.upkeep"]);
  for (const g of FEATURE_GROUPS) for (const i of g.items) assert.ok(i.title && i.detail, i.id);
});

test("disabledFeatures lists what is off; everything else is on", () => {
  assert.equal(featureOn([], "zip"), true);
  assert.equal(featureOn(undefined, "zip"), true);
  assert.equal(featureOn(["zip"], "zip"), false);
  assert.deepEqual(withFeature([], "zip", false), ["zip"]);
  assert.deepEqual(withFeature(["zip"], "zip", false), ["zip"], "never twice");
  assert.deepEqual(withFeature(["zip", "pdf"], "zip", true), ["pdf"]);
  assert.deepEqual(withFeature(["future"], "pdf", false), ["future", "pdf"], "unknown ids are kept");
});

test("right side: saved items first in their order, the others after", () => {
  assert.deepEqual(RIGHT_IDS, ["job", "timer", "meeting", "media", "shelf", "glance", "download", "devservers"]);
  const rows = rightRows(["media", "job", "nope", "media"]);
  assert.deepEqual(rows.slice(0, 2), [{ id: "media", on: true }, { id: "job", on: true }]);
  assert.equal(rows.length, RIGHT_IDS.length);
  assert.ok(rows.slice(2).every((r) => !r.on));
  assert.deepEqual(rightWidgetsOf(rows), ["media", "job"]);
  assert.deepEqual(rightWidgetsOf(rightRows(undefined)), []);
});

test("moving a row swaps it with its neighbour, never past an end", () => {
  assert.deepEqual(moveRow(["a", "b", "c"], 1, -1), ["b", "a", "c"]);
  assert.deepEqual(moveRow(["a", "b", "c"], 1, 1), ["a", "c", "b"]);
  assert.deepEqual(moveRow(["a", "b", "c"], 0, -1), ["a", "b", "c"]);
  assert.deepEqual(moveRow(["a", "b", "c"], 2, 1), ["a", "b", "c"]);
});

test("numbers typed in a field stay in range", () => {
  assert.equal(clampNumber("1", ROTATE_RANGE, 6), 3);
  assert.equal(clampNumber("99", ROTATE_RANGE, 6), 30);
  assert.equal(clampNumber("12.4", ROTATE_RANGE, 6), 12);
  assert.equal(clampNumber("", ROTATE_RANGE, 6), 6);
  assert.equal(clampNumber("abc", FOCUS_RANGE, 25), 25);
  assert.equal(clampNumber(200, FOCUS_RANGE, 25), 120);
  assert.equal(clampNumber(0, BREAK_RANGE, 5), 1);
});

test("calendar links: web and webcal only, cleaned up", () => {
  assert.equal(calendarLink("  https://example.com/cal.ics "), "https://example.com/cal.ics");
  assert.equal(calendarLink("<webcal://p01-caldav.icloud.com/published/2/abc>"), "webcal://p01-caldav.icloud.com/published/2/abc");
  assert.equal(calendarLink("\"http://x.test/a.ics\""), "http://x.test/a.ics");
  assert.equal(calendarLink("file:///C:/cal.ics"), null);
  assert.equal(calendarLink("javascript:alert(1)"), null);
  assert.equal(calendarLink("example.com/cal.ics"), null);
  assert.equal(calendarLink(""), null);
});

// ── Pages ────────────────────────────────────────────────────────────────────

test("Features page: a switch per feature, writing disabledFeatures", () => {
  const s = store({ disabledFeatures: ["pdf"] });
  const sections = featuresSections(s.access);
  assert.equal(sections.length, 5);
  assert.deepEqual(sections.map((el) => el.dataset.anchor), ["features.drop", "features.tabs", "features.notch", "features.tools", "features.upkeep"]);
  const rows = sections.flatMap((el) => el.find(".feature-row"));
  assert.equal(rows.length, FEATURE_IDS.length);
  const pdf = rows[FEATURE_IDS.indexOf("pdf")];
  assert.ok(pdf.classList.contains("off"));

  rows[FEATURE_IDS.indexOf("zip")].find(".switch")[0].fire("click");
  assert.deepEqual(s.settings.disabledFeatures, ["pdf", "zip"]);
  pdf.find(".switch")[0].fire("click");
  assert.deepEqual(s.settings.disabledFeatures, ["zip"]);
  assert.ok(!pdf.classList.contains("off"));
});

/** Calls the keydown listeners of `el` with `key`. */
function press(el, key) {
  const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
  for (const fn of el.listeners.get("keydown") ?? []) fn(event);
  return event;
}

test("Notch page: a live preview, then the two sides, then calendar and focus", () => {
  const s = store();
  const sections = notchSections(s.access);
  assert.deepEqual(sections.map((el) => el.dataset.anchor), ["notch.preview", "notch.sides", "notch.calendar", "notch.focus"]);
  // The island's own markup: two sides of two layers each, in a compact notch.
  const notch = sections[0].find(".notch-preview")[0];
  assert.ok(notch.classList.contains("compact"));
  assert.equal(notch.find(".notch-side").length, 2);
  assert.equal(notch.find(".ns-layer").length, 4);
});

test("Notch page: both sides list every item once; switches, keys and the arrow button write the settings", () => {
  // An older file: no left list yet, and the right side as the user set it.
  const s = store({ leftWidgets: undefined, leftOff: undefined, rightOff: undefined, rightWidgets: ["job", "media"] });
  const [, sides] = notchSections(s.access);
  const [left, right] = sides.find(".side-list");
  const names = (list) => list.children.filter((r) => r.classList.contains("side-row")).map((r) => r.getAttribute("data-id"));
  assert.deepEqual(names(left), ["reminder"]);
  assert.deepEqual(names(right), ["job", "media", "timer", "meeting", "shelf", "glance", "download", "devservers"]);
  const row = (id) => sides.find(".side-row").find((r) => r.getAttribute("data-id") === id);
  assert.ok(!row("job").classList.contains("off"));
  assert.ok(row("timer").classList.contains("off"));

  // Switching an item on adds it to its side's turn.
  row("timer").find(".switch")[0].fire("click");
  assert.deepEqual(s.settings.rightWidgets, ["job", "media", "timer"]);
  assert.deepEqual(s.settings.leftWidgets, ["reminder"]);

  // The arrow button sends it to the other side, at the end; switched off, it stays there.
  row("media").find(".side-move")[0].fire("click");
  assert.deepEqual(names(left), ["reminder", "media"]);
  assert.deepEqual(s.settings.leftWidgets, ["reminder", "media"]);
  assert.deepEqual(s.settings.rightWidgets, ["job", "timer"]);
  row("media").find(".switch")[0].fire("click");
  assert.deepEqual(s.settings.leftWidgets, ["reminder"]);
  assert.deepEqual(s.settings.leftOff, ["media"]);
  assert.ok(!s.settings.rightOff.includes("media"));

  // Keys on the handle: up and down within a side, left and right across.
  const grip = (id) => row(id).find(".side-grip")[0];
  assert.ok(press(grip("media"), "ArrowUp").defaultPrevented);
  assert.deepEqual(names(left), ["media", "reminder"]);
  press(grip("media"), "ArrowUp"); // already first: nothing changes
  assert.deepEqual(names(left), ["media", "reminder"]);
  press(grip("shelf"), "ArrowLeft");
  assert.deepEqual(names(left), ["media", "reminder", "shelf"]);
  assert.ok(!names(right).includes("shelf"), "moved, not copied");
  press(grip("reminder"), "ArrowRight");
  assert.deepEqual(names(right).slice(0, 2), ["job", "reminder"]);
  assert.deepEqual(s.settings.rightWidgets, ["job", "reminder", "timer"]);

  // Every item is in exactly one list, whatever happened.
  assert.deepEqual([...names(left), ...names(right)].sort(), [...SIDE_IDS].sort());

  // The rows' arrow points at the other side.
  assert.equal(row("shelf").find(".side-move")[0].title, "Move to the right side");
  assert.equal(row("job").find(".side-move")[0].title, "Move to the left side");
});

test("Notch page: an emptied side says where to drag items", () => {
  const s = store({ leftWidgets: ["reminder"] });
  const [, sides] = notchSections(s.access);
  const [left] = sides.find(".side-list");
  const reminder = sides.find(".side-row").find((r) => r.getAttribute("data-id") === "reminder");
  reminder.find(".side-move")[0].fire("click");
  assert.ok(left.classList.contains("empty"));
  assert.equal(left.find(".side-empty")[0].textContent, "Drag items here");
  assert.deepEqual(s.settings.leftWidgets, []);
});

test("notch sides: rows from the settings, and the settings from rows", () => {
  // Defaults and an older file: the reminder on the left, the rest on the right.
  const rows = sideRows({ rightWidgets: ["media"] });
  assert.deepEqual(rows.left, [{ id: "reminder", on: true }]);
  assert.deepEqual(rows.right[0], { id: "media", on: true });
  assert.equal(rows.right.length, SIDE_IDS.length - 1);
  // Off items stay on the side they were put; unknown ids, "privacy" and repeats are dropped.
  const placed = sideRows({
    leftWidgets: ["timer", "nope", "timer"], rightWidgets: ["privacy", "timer", "shelf"], leftOff: ["media"], rightOff: ["reminder"],
  });
  assert.deepEqual(placed.left, [{ id: "timer", on: true }, { id: "media", on: false }]);
  assert.deepEqual(placed.right.slice(0, 2), [{ id: "shelf", on: true }, { id: "reminder", on: false }]);
  assert.deepEqual(sideSettingsOf(placed), {
    leftWidgets: ["timer"], rightWidgets: ["shelf"], leftOff: ["media"],
    rightOff: ["reminder", "job", "meeting", "glance", "download", "devservers"],
  });
  // Placing: across at an index, within a side, and nothing for an unknown id.
  assert.deepEqual(placeRow(placed, "shelf", "left", 1).left.map((r) => r.id), ["timer", "shelf", "media"]);
  assert.deepEqual(placeRow(placed, "media", "left", 0).left.map((r) => r.id), ["media", "timer"]);
  assert.deepEqual(placeRow(placed, "nope", "left", 0), placed);
});

test("notch sides: a change keeps the ids a newer Pod wrote, not retired ones", () => {
  const saved = { leftWidgets: ["clock", "reminder"], rightWidgets: ["privacy", "media"], rightOff: ["weather"] };
  const rows = placeRow(sideRows(saved), "media", "left", 0);
  const out = sideSettingsKeeping(saved, rows);
  assert.deepEqual(out.leftWidgets, ["media", "reminder", "clock"]);
  assert.deepEqual(out.rightWidgets, []);
  assert.ok(out.rightOff.includes("weather"));
  assert.ok(!out.rightOff.includes("privacy") && !out.rightWidgets.includes("privacy"));
});

test("Notch page: adding a calendar link saves it and tests it", async () => {
  const s = store();
  const [, , calendar] = notchSections(s.access);
  assert.equal(calendar.dataset.anchor, "notch.calendar");
  const input = calendar.find("INPUT")[0];
  const addButton = calendar.find("BUTTON").find((b) => b.textContent === "Add");

  const invoke = internals.invoke;
  const asked = [];
  internals.invoke = async (cmd, args) => {
    if (cmd === "calendar_test") {
      asked.push(args.url);
      return 12;
    }
    return invoke(cmd, args);
  };
  try {
    input.value = "ftp://nope";
    addButton.fire("click");
    assert.deepEqual(s.settings.calendarUrls, []);
    assert.equal(calendar.find(".notice")[0].textContent, "Paste an http, https or webcal link.");

    input.value = " https://example.com/me.ics ";
    addButton.fire("click");
    assert.deepEqual(s.settings.calendarUrls, ["https://example.com/me.ics"]);
    await settle();
    await settle();
    assert.deepEqual(asked, ["https://example.com/me.ics"]);
    assert.ok(calendar.find(".tag").some((tag) => tag.textContent === "12 events found"));

    input.value = "https://example.com/me.ics";
    addButton.fire("click");
    assert.deepEqual(s.settings.calendarUrls, ["https://example.com/me.ics"], "not twice");

    calendar.find("BUTTON").find((b) => b.textContent === "Remove").fire("click");
    assert.deepEqual(s.settings.calendarUrls, []);
  } finally {
    internals.invoke = invoke;
  }
});

test("Notch page: lengths are kept in range", () => {
  const s = store();
  const [, sides, , focus] = notchSections(s.access);
  const [leftSeconds, rightSeconds] = sides.find("INPUT");
  leftSeconds.value = "1";
  leftSeconds.fire("change");
  assert.equal(s.settings.leftRotateSeconds, 3);
  rightSeconds.value = "99";
  rightSeconds.fire("change");
  assert.equal(s.settings.rotateSeconds, 30);
  const [work, rest] = focus.find("INPUT");
  work.value = "500";
  work.fire("change");
  rest.value = "10";
  rest.fire("change");
  assert.equal(s.settings.focusMinutes, 120);
  assert.equal(s.settings.breakMinutes, 10);
});
