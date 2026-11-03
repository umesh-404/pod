// Focus timer (core/focus.ts): phases, one timer per phase, persistence.

import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { Focus, _resetFocusForTests } = await import("../src/core/focus.ts");
const { State } = await import("../src/core/state.ts");

const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);
const MIN = 60_000;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  store.clear();
  _resetFocusForTests();
  State.settings = { ...State.settings, focusMinutes: 25, breakMinutes: 5 };
});

afterEach(() => {
  _resetFocusForTests();
  mock.timers.reset();
});

test("off at first", () => {
  assert.deepEqual(Focus.state(), { phase: "off", endsAt: 0, length: 0 });
});

test("focus, then break, then off, with lengths from Settings", () => {
  State.settings.focusMinutes = 50;
  State.settings.breakMinutes = 10;
  const seen = [];
  Focus.on((s) => seen.push(s.phase));
  Focus.start();
  assert.deepEqual(Focus.state(), { phase: "focus", endsAt: T0 + 50 * MIN, length: 50 * MIN });

  mock.timers.tick(50 * MIN - 1);
  assert.equal(Focus.state().phase, "focus");
  mock.timers.tick(1);
  assert.equal(Focus.state().phase, "break");
  assert.equal(Focus.state().length, 10 * MIN);
  assert.equal(Focus.state().endsAt, T0 + 60 * MIN);

  mock.timers.tick(10 * MIN);
  assert.equal(Focus.state().phase, "off");
  assert.deepEqual(seen, ["focus", "break", "off"]);
});

test("notifies on phase changes only, never per second", () => {
  let calls = 0;
  const off = Focus.on(() => calls++);
  Focus.start();
  for (let i = 0; i < 60; i++) mock.timers.tick(1000);
  assert.equal(calls, 1);
  Focus.stop();
  assert.equal(calls, 2);
  // Stopping again changes nothing.
  Focus.stop();
  assert.equal(calls, 2);
  off();
  Focus.start();
  assert.equal(calls, 2);
});

test("skip: focus → break → off", () => {
  Focus.start();
  mock.timers.tick(3 * MIN);
  Focus.skip();
  assert.equal(Focus.state().phase, "break");
  assert.equal(Focus.state().endsAt, T0 + 3 * MIN + 5 * MIN);
  Focus.skip();
  assert.equal(Focus.state().phase, "off");
  Focus.skip();
  assert.equal(Focus.state().phase, "off");
});

test("stop cancels the pending phase end", () => {
  Focus.start();
  Focus.stop();
  mock.timers.tick(30 * MIN);
  assert.equal(Focus.state().phase, "off");
});

test("persists and resumes after a reload", () => {
  Focus.start();
  const saved = JSON.parse(store.get("pod.focus"));
  assert.equal(saved.phase, "focus");
  assert.equal(saved.endsAt, T0 + 25 * MIN);

  // A new page, ten minutes later.
  _resetFocusForTests();
  mock.timers.tick(10 * MIN);
  assert.equal(Focus.state().phase, "focus");
  assert.equal(Focus.state().endsAt, T0 + 25 * MIN);
  mock.timers.tick(15 * MIN);
  assert.equal(Focus.state().phase, "break");

  Focus.stop();
  assert.equal(store.has("pod.focus"), false);
});

test("a focus that ended while away resumes in its break, or off", () => {
  Focus.start();
  _resetFocusForTests();
  mock.timers.tick(27 * MIN);
  assert.deepEqual(Focus.state(), { phase: "break", endsAt: T0 + 30 * MIN, length: 5 * MIN });

  _resetFocusForTests();
  mock.timers.tick(10 * MIN);
  assert.equal(Focus.state().phase, "off");
});

test("bad saved data is ignored", () => {
  store.set("pod.focus", "{not json");
  assert.equal(Focus.state().phase, "off");
  _resetFocusForTests();
  store.set("pod.focus", JSON.stringify({ phase: "nap", endsAt: T0 + MIN }));
  assert.equal(Focus.state().phase, "off");
});
