// The tucked pill's rules (src/island/tuck.ts): countdown text, progress, and
// what makes it glow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const {
  MEETING_SOON_MS, SOON_MS, tuckAlert, tuckAlertChangeIn, tuckPercent, tuckProgress, tuckShort, tuckShortChangeIn, tuckSoon, tuckTime,
} = await import("../src/island/tuck.ts");

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const base = {
  reminders: [], meeting: null, downloadUntil: null, remindersOn: true, meetingOn: true, downloadOn: true,
};

test("the countdown reads like a clock, and in hours past one", () => {
  assert.equal(tuckTime(25 * MIN), "25:00");
  assert.equal(tuckTime(7_200), "0:08");
  assert.equal(tuckTime(0), "0:00");
  assert.equal(tuckTime(-5), "0:00");
  assert.equal(tuckTime(65 * MIN), "1h05");
});

test("progress is the share of the phase left", () => {
  const f = { phase: "focus", endsAt: NOW + 5 * MIN, length: 20 * MIN };
  assert.equal(tuckProgress(f, NOW), 0.25);
  assert.equal(tuckProgress({ phase: "off", endsAt: 0, length: 0 }, NOW), 0);
  assert.equal(tuckProgress(f, NOW + 30 * MIN), 0);
});

test("a fired reminder glows first, and only when reminders are on", () => {
  const reminders = [{ id: "a", text: "x", due: NOW - MIN, deadline: false, fired: true }];
  const download = NOW + MIN;
  assert.equal(tuckAlert({ ...base, reminders, downloadUntil: download }, NOW), "reminder");
  assert.equal(tuckAlert({ ...base, reminders, remindersOn: false }, NOW), null);
  assert.equal(tuckAlert(base, NOW), null);
});

test("a meeting glows from five minutes before to two minutes in", () => {
  const meeting = { title: "Standup", start: NOW + 10 * MIN, end: NOW + 40 * MIN, link: null, location: "" };
  const o = { ...base, meeting };
  assert.equal(tuckAlert(o, NOW), null);
  assert.equal(tuckAlertChangeIn(o, NOW), 10 * MIN - MEETING_SOON_MS);
  assert.equal(tuckAlert(o, NOW + 6 * MIN), "meeting");
  assert.equal(tuckAlert(o, NOW + 11 * MIN), "meeting");
  assert.equal(tuckAlert(o, NOW + 13 * MIN), null);
  assert.equal(tuckAlert({ ...o, meetingOn: false }, NOW + 6 * MIN), null);
});

test("a new download glows until its offer runs out", () => {
  const o = { ...base, downloadUntil: NOW + 2 * MIN };
  assert.equal(tuckAlert(o, NOW), "download");
  assert.equal(tuckAlertChangeIn(o, NOW), 2 * MIN);
  assert.equal(tuckAlert(o, NOW + 3 * MIN), null);
  assert.equal(tuckAlert({ ...o, downloadOn: false }, NOW), null);
});

test("the next reminder within the hour counts down; fired, past and later ones don't", () => {
  const r = (id, due, fired = false) => ({ id, text: "x", due, deadline: false, fired });
  const list = [r(1, NOW + 50 * MIN), r(2, NOW + 4 * MIN), r(3, NOW - MIN), r(4, NOW + 2 * MIN, true), r(5, NOW + 2 * SOON_MS)];
  assert.equal(tuckSoon(list, NOW, true)?.id, 2);
  assert.equal(tuckSoon(list, NOW, false), null);
  assert.equal(tuckSoon([r(5, NOW + 2 * SOON_MS)], NOW, true), null);
});

test("the short countdown takes the narrowest unit, rounded up", () => {
  assert.equal(tuckShort(45_000, "en"), "45s");
  assert.equal(tuckShort(3 * MIN + 1, "en"), "4m");
  assert.equal(tuckShort(60 * MIN, "en"), "1h");
  assert.equal(tuckShort(61 * MIN, "en"), "2h");
  assert.equal(tuckShortChangeIn(45_500), 500);
  assert.equal(tuckShortChangeIn(3 * MIN + 1), 1);
  assert.equal(tuckShortChangeIn(4 * MIN), 60_000);
});

test("a job's progress reads as a whole percentage", () => {
  assert.equal(tuckPercent(0.427), "42%");
  assert.equal(tuckPercent(1.2), "100%");
  assert.equal(tuckPercent(-1), "0%");
});
