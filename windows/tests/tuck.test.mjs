// The tucked pill's rules (src/island/tuck.ts): countdown text, progress, and
// what makes it glow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { MEETING_SOON_MS, tuckAlert, tuckAlertChangeIn, tuckProgress, tuckTime } = await import("../src/island/tuck.ts");

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
