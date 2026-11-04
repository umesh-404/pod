// The launch greeting (src/mochi/greeting.ts): Stew must never be cut off by
// the island while it grows, while he bounces and waves, or while it shrinks
// back to the compact island.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GREETING_END, GREETING_W, greetingPose, mochiBounds } from "../src/mochi/greeting.ts";
import { Tracked } from "../src/core/anim.ts";
import { COMPACT_W, NOTCH_H, NOTCH_W, VIEW_LAYOUTS } from "../src/core/layout.ts";

const FRAME = 1 / 60;
const SLACK = 0.5; // anti-aliasing

/** Stew's box against the island's, which is centred in the 640 px greeting canvas. */
function assertInside(t, tc, w, h) {
  const b = mochiBounds(greetingPose(t, tc));
  if (!b) return;
  const left = GREETING_W / 2 - w / 2;
  const right = GREETING_W / 2 + w / 2;
  const at = `t=${t.toFixed(3)} tc=${tc}`;
  // No check on the top: he drops in from the edge of the screen, like out of
  // the notch on a Mac, so his head is meant to come out of it.
  assert.ok(b.bottom <= h + SLACK, `${at}: bottom ${b.bottom.toFixed(1)} below the island (${h.toFixed(1)})`);
  assert.ok(b.left >= left - SLACK, `${at}: left ${b.left.toFixed(1)} outside ${left.toFixed(1)}`);
  assert.ok(b.right <= right + SLACK, `${at}: right ${b.right.toFixed(1)} outside ${right.toFixed(1)}`);
}

/** Runs the island geometry the way Island does: spring open, then the 340 ms close curve. */
function run(tc) {
  const width = new Tracked(NOTCH_W);
  const height = new Tracked(0);
  width.springTo(GREETING_W);
  height.springTo(VIEW_LAYOUTS.greeting.height);
  let collapsed = false;
  const stop = Number.isFinite(tc) ? tc + 0.6 : GREETING_END + 0.5;
  for (let t = 0; t <= stop; t += FRAME) {
    const now = t * 1000;
    if (!collapsed && t >= tc) {
      collapsed = true;
      width.curveTowards(COMPACT_W, 340, now);
      height.curveTowards(NOTCH_H, 340, now);
    }
    width.step(FRAME, now);
    height.step(FRAME, now);
    assertInside(t, tc, width.value, height.value);
  }
}

test("Stew stays inside the island for the whole greeting", () => {
  run(Number.POSITIVE_INFINITY);
});

test("Stew stays inside the island when the greeting is cut short", () => {
  for (let tc = 0.3; tc < GREETING_END + 0.4; tc += 0.1) run(tc);
});

test("he wakes, rolls aside to say hello, then rolls back to the middle", () => {
  assert.equal(greetingPose(0.8).eye, "closed", "asleep while he bounces in");
  const atWave = greetingPose(2.3);
  assert.ok(atWave.x < 290, `waving at x=${atWave.x}`);
  assert.ok(atWave.wave >= 0, "waving");
  // Rolling without slipping: one full turn over his circumference.
  const rolled = greetingPose(2.12);
  assert.ok(Math.abs(rolled.roll + (320 - rolled.x) / (rolled.hb / 2)) < 1e-9, "roll matches the distance");
  const back = greetingPose(3.6);
  assert.equal(back.x, 320);
  assert.equal(back.wave, -1);
});

test("he lands where the compact island's Stew sits", () => {
  const end = greetingPose(10, 5);
  assert.equal(end.y, NOTCH_H / 2);
  assert.equal(end.x, GREETING_W / 2);
  assert.equal(end.roll, 0);
});
