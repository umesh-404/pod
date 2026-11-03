// The compact notch's sides (island/notch.ts) and the open island's tabs
// (island/tabs.ts): the pure parts — the left side's reminder and countdown,
// the right side's items, their turn, and which tab shows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const {
  DOWNLOAD_TTL_MS, countdownChangeIn, countdownText, leftText, nextItem, pickLeft, rightItems,
} = await import("../src/island/notch.ts");
const { TAB_IDS, pickTab, visibleTabs } = await import("../src/island/tabs.ts");
const { tabSound } = await import("../src/island/island.ts");

const NOW = Date.UTC(2026, 10, 3, 9, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

const reminder = (over) => ({ id: 1, text: "Essay", due: NOW + 2 * HOUR, fired: false, deadline: true, ...over });

test("countdowns: days and hours, hours and minutes, seconds under an hour", () => {
  assert.equal(countdownText(2 * 24 * HOUR + 4 * HOUR + 59 * MIN), "2d 4h");
  assert.equal(countdownText(3 * HOUR + 20 * MIN + 30_000), "3h 20m");
  assert.equal(countdownText(35 * MIN + 5_000), "35m 05s");
  assert.equal(countdownText(-5), "0m 00s");
  // The next change: a second under an hour, the minute's turn above.
  assert.equal(countdownChangeIn(35 * MIN + 5_400), 400);
  assert.equal(countdownChangeIn(3 * HOUR + 20 * MIN + 30_000), 30_000);
  assert.equal(countdownChangeIn(2 * HOUR), MIN);
});

test("the left side: a fired reminder first, else the nearest deadline, else nothing", () => {
  assert.equal(pickLeft([], NOW), null);
  // Plain reminders (no deadline) wait for their time; they don't count down.
  assert.equal(pickLeft([reminder({ deadline: false })], NOW), null);
  // A deadline that passed without firing is not counted down.
  assert.equal(pickLeft([reminder({ due: NOW - MIN })], NOW), null);

  const far = reminder({ id: 1, text: "Far", due: NOW + 3 * 24 * HOUR });
  const near = reminder({ id: 2, text: "Essay", due: NOW + 35 * MIN });
  const pick = pickLeft([far, near], NOW);
  assert.equal(pick.reminder.id, 2);
  assert.equal(pick.fired, false);
  assert.equal(leftText(pick, NOW), "Essay · 35m 00s");

  // Fired ones (also those missed while Pod was off) come first, the latest of them.
  const old = reminder({ id: 3, text: "Call mum", fired: true, deadline: false, due: NOW - HOUR });
  const late = reminder({ id: 4, text: "Stand up", fired: true, deadline: false, due: NOW - MIN });
  const fired = pickLeft([far, near, old, late], NOW);
  assert.equal(fired.reminder.id, 4);
  assert.equal(fired.fired, true);
  assert.equal(leftText(fired, NOW), "Stand up");
});

const empty = {
  job: null, focus: { phase: "off", endsAt: 0, length: 0 }, meeting: null, media: null, shelfCount: 0,
  glance: null, privacy: null, download: null, devservers: [],
};
const ALL = ["job", "timer", "meeting", "media", "shelf", "glance", "privacy", "download", "devservers"];

test("the right side: only items with something to show, in the settings' order", () => {
  assert.deepEqual(rightItems(ALL, [], empty, NOW), []);
  const d = {
    ...empty,
    media: { title: "Song", artist: "A", app: "Spotify", playing: true, art: null },
    shelfCount: 3,
    devservers: [{ port: 5173, pid: 1, process: "node", url: "http://localhost:5173" }, { port: 8000, pid: 2, process: "python", url: "" }],
    glance: { cpu: 12.4, ramUsed: 8, ramTotal: 16, battery: null, netDown: 0, netUp: 0 },
  };
  const items = rightItems(["shelf", "media", "devservers", "glance", "nope"], [], d, NOW);
  assert.deepEqual(items.map((i) => i.id), ["shelf", "media", "devservers", "glance"]);
  assert.equal(items[0].text, "Shelf · 3");
  assert.equal(items[1].text, "Song");
  assert.equal(items[1].icon, "pause");
  assert.equal(items[2].text, ":5173 node +1");
  assert.equal(items[3].text, "CPU 12% · RAM 50%");
  // A switched-off feature is left out; an item not in the list never shows.
  assert.deepEqual(rightItems(["shelf", "media"], ["media"], d, NOW).map((i) => i.id), ["shelf"]);
  assert.deepEqual(rightItems(["glance"], [], d, NOW).map((i) => i.id), ["glance"]);
});

test("the camera and microphone have their own lights, never a turn on the right", () => {
  const d = { ...empty, shelfCount: 2, privacy: { mic: ["Zoom"], camera: ["Zoom"] } };
  // An older settings file may still list "privacy" among the right side's items.
  assert.deepEqual(rightItems(["shelf", "privacy"], [], d, NOW).map((i) => i.id), ["shelf"]);
  assert.deepEqual(rightItems(["privacy"], [], d, NOW), []);
});

test("meeting, timer, download and job texts, and when they change by themselves", () => {
  const meeting = (start, end = start + 30 * MIN) => ({ title: "Standup", start, end, link: null, location: "" });
  const soon = rightItems(["meeting"], [], { ...empty, meeting: meeting(NOW + 12 * MIN - 1) }, NOW)[0];
  assert.equal(soon.text, "Standup · in 12 min");
  assert.ok(soon.changeIn > 0 && soon.changeIn <= MIN);
  assert.equal(rightItems(["meeting"], [], { ...empty, meeting: meeting(NOW - MIN) }, NOW)[0].text, "Standup · now");
  assert.deepEqual(rightItems(["meeting"], [], { ...empty, meeting: meeting(NOW - HOUR, NOW - MIN) }, NOW), []);
  assert.deepEqual(rightItems(["meeting"], [], { ...empty, meeting: meeting(NOW + 20 * HOUR) }, NOW), []);

  const timer = rightItems(["timer"], [], { ...empty, focus: { phase: "focus", endsAt: NOW + 12 * MIN + 4_500, length: 25 * MIN } }, NOW)[0];
  assert.equal(timer.text, "Focus · 12:05");
  assert.equal(timer.changeIn, 500);
  const pause = rightItems(["timer"], [], { ...empty, focus: { phase: "break", endsAt: NOW + 59_000, length: 5 * MIN } }, NOW)[0];
  assert.equal(pause.text, "Break · 0:59");

  const download = { item: { path: "C:\\\\Downloads\\\\report.pdf", name: "report.pdf", size: 1 }, until: NOW + DOWNLOAD_TTL_MS };
  const dl = rightItems(["download"], [], { ...empty, download }, NOW)[0];
  assert.equal(dl.text, "report.pdf");
  assert.equal(dl.chip, "Add to shelf");
  assert.equal(dl.changeIn, DOWNLOAD_TTL_MS);
  // Two minutes on, it is gone.
  assert.deepEqual(rightItems(["download"], [], { ...empty, download }, NOW + DOWNLOAD_TTL_MS), []);

  const format = { id: "mp4", label: "MP4" };
  const job = { kind: "converting", job: { id: 1, names: ["a.mov"], kind: "video", formats: [] }, format, index: 0, count: 1, fraction: 0.42 };
  assert.equal(rightItems(["job"], [], { ...empty, job }, NOW)[0].text, "MP4 · 42 %");
  assert.equal(rightItems(["job"], [], { ...empty, job: { kind: "working", title: "Zipping…" } }, NOW)[0].text, "Zipping…");
  assert.deepEqual(rightItems(["job"], [], { ...empty, job: { kind: "error", title: "x", message: "y" } }, NOW), []);
});

test("the turn goes round the items", () => {
  const items = [{ id: "shelf" }, { id: "media" }, { id: "glance" }];
  assert.equal(nextItem(items, "shelf"), "media");
  assert.equal(nextItem(items, "glance"), "shelf");
  assert.equal(nextItem(items, "timer"), "shelf");
  assert.equal(nextItem([], "shelf"), null);
});

test("tabs: the ones switched on, in order; the current, the remembered or the first", () => {
  assert.deepEqual([...TAB_IDS], ["shelf", "reminders", "notes", "tools"]);
  assert.deepEqual(visibleTabs([]), ["shelf", "reminders", "notes", "tools"]);
  assert.deepEqual(visibleTabs(["notes", "convert"]), ["shelf", "reminders", "tools"]);
  assert.deepEqual(visibleTabs(["shelf", "reminders", "notes", "tools"]), []);
  assert.equal(pickTab(["shelf", "tools"], "tools", "shelf"), "tools");
  assert.equal(pickTab(["shelf", "tools"], "notes", "tools"), "tools");
  assert.equal(pickTab(["shelf", "tools"], null, "bogus"), "shelf");
  assert.equal(pickTab([], "shelf", "shelf"), null);
});

test("a tab's sound names map to the app's sounds", () => {
  assert.equal(tabSound("success"), "approve");
  assert.equal(tabSound("error"), "error");
  assert.equal(tabSound("pop"), "pop");
  assert.equal(tabSound("no-such-sound"), "blip");
});
