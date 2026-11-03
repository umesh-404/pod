// Settings → Features and Settings → Notch: the rules behind their switches
// (src/settings/catalog.ts) and what the pages write when they are used.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { internals } from "./tauri.mjs";

installFakeDom();

const {
  FEATURE_GROUPS, FEATURE_IDS, RIGHT_IDS, calendarLink, clampNumber, featureOn, moveRow, rightRows,
  rightWidgetsOf, withFeature, ROTATE_RANGE, FOCUS_RANGE, BREAK_RANGE,
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
    ["capture", "clipboard", "convert", "devservers", "focus", "notes", "pdf", "privacy", "reminders", "resize", "shelf", "tools", "workspace", "zip"],
  );
  assert.deepEqual(FEATURE_GROUPS.map((g) => g.anchor), ["features.drop", "features.tabs", "features.notch", "features.tools"]);
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
  assert.equal(sections.length, 4);
  assert.deepEqual(sections.map((el) => el.dataset.anchor), ["features.drop", "features.tabs", "features.notch", "features.tools"]);
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

test("Notch page: switching and reordering the right side writes rightWidgets", () => {
  const s = store({ rightWidgets: ["job", "media"] });
  const [right] = notchSections(s.access);
  assert.equal(right.dataset.anchor, "notch.right");
  const list = right.find(".notch-list")[0];
  const order = () => list.children.map((r) => r.find(".name")[0].textContent);
  assert.deepEqual(order().slice(0, 3), ["File jobs", "Now playing", "Focus timer"]);

  const rowOf = (name) => list.children.find((r) => r.find(".name")[0].textContent === name);
  const buttons = (row) => row.find(".hub-icon");
  // The first row can't go up, the last can't go down.
  assert.equal(buttons(list.children[0])[0].disabled, true);
  assert.equal(buttons(list.children.at(-1))[1].disabled, true);

  buttons(rowOf("Now playing"))[0].fire("click"); // up
  assert.deepEqual(order().slice(0, 2), ["Now playing", "File jobs"]);
  assert.equal(list.children.length, RIGHT_IDS.length, "rows are moved, not copied");
  assert.deepEqual(s.settings.rightWidgets, ["media", "job"]);

  rowOf("Focus timer").find(".switch")[0].fire("click");
  assert.deepEqual(s.settings.rightWidgets, ["media", "job", "timer"]);
  rowOf("File jobs").find(".switch")[0].fire("click");
  assert.deepEqual(s.settings.rightWidgets, ["media", "timer"]);

  // Moving a row at an end changes nothing.
  const writes = s.writes.length;
  buttons(list.children[0])[0].fire("click");
  assert.equal(s.writes.length, writes);
});

test("Notch page: adding a calendar link saves it and tests it", async () => {
  const s = store();
  const [, calendar] = notchSections(s.access);
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
  const [right, , focus] = notchSections(s.access);
  const seconds = right.find("INPUT")[0];
  seconds.value = "1";
  seconds.fire("change");
  assert.equal(s.settings.rotateSeconds, 3);
  const [work, rest] = focus.find("INPUT");
  work.value = "500";
  work.fire("change");
  rest.value = "10";
  rest.fire("change");
  assert.equal(s.settings.focusMinutes, 120);
  assert.equal(s.settings.breakMinutes, 10);
});
