// The launch greeting: Stew drops out of the notch, bounces twice and wakes
// up with a pleased little stretch. Then he rolls away to the side — a real
// roll, one full turn over his own circumference, his face going round while
// the light on him stays put — rocks hello, rolls back to the middle and
// settles in the compact island. Everything is laid out in a 640×150
// reference space.

import { closeCurve } from "../core/anim";
import { Sound } from "../core/sound";
import { COMPACT_W, NOTCH_H, NOTCH_W } from "../core/layout";
import { PEA_DROP, PEA_SCALE, drawStew, restPose, type StewEye } from "./stew";

// ── Timing ────────────────────────────────────────────────────────────────────

const T = {
  appear: 0.18,
  land1: 0.55,
  land2: 0.95,
  land3: 1.2,
  wake: 1.22,
  pop0: 1.3,
  pop1: 1.6,
  roll0: 1.6,
  roll1: 2.15,
  wave0: 2.15,
  wave1: 2.75,
  back0: 2.85,
  back1: 3.55,
  blink2: 3.8,
  end: 4.6,
  autoLeave: 4.9,
  COLLAPSE: 0.34,
};

export const GREETING_END = T.end;

/** The greeting's own sound, played from the start. */
const GREETING_SOUND = "greeting";

// ── Geometry (640×150) ────────────────────────────────────────────────────────

export const GREETING_W = 640;
export const GREETING_H = 150;
const C0 = { x: 320, y: 92 };
/** His diameter at full size. */
const HB = 56;
/** Width over height of his body: a ball is round. */
export const ASP = 1;
const CARD = { x: 10, y: 36, w: 620, h: 104 };
const CARD_R = 20;
/** One full turn of rolling covers his circumference. */
const ROLL_DIST = Math.PI * HB;

/** Where the compact island's Stew sits (engine.ts: slot 20 px, centred at y 16). */
const COMPACT = {
  width: COMPACT_W,
  height: NOTCH_H,
  diameter: Math.min(20, Math.max(0, NOTCH_H - 6)),
  centerY: NOTCH_H / 2,
};
const COMPACT_HB = COMPACT.diameter * PEA_SCALE;
const COMPACT_Y = COMPACT.centerY + (COMPACT.diameter / 2) * PEA_DROP;

// ── Easing ────────────────────────────────────────────────────────────────────

const E = {
  out: (t: number) => 1 - Math.pow(1 - t, 3),
  quadIn: (t: number) => t * t,
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);
/** A hop from 0 up to 1 and back over k = 0…1. */
const arc = (k: number) => 4 * k * (1 - k);

function reducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// ── Pose ──────────────────────────────────────────────────────────────────────

export interface Pose {
  /** Diameter, centre (of the unsquashed ball), squash about his bottom. */
  hb: number; x: number; y: number; sx: number; sy: number;
  /** Face turned around the view axis: rocking (tilt) and rolling (roll). */
  tilt: number; roll: number;
  eye: StewEye; open: number;
  lookX: number; lookY: number;
  /** Seconds into the hello, −1 when not waving. */
  wave: number;
  blush: number;
  halo: number; fx: number;
  header: number; card: number;
  iw: number; ih: number;
}

/** Squash on landing: 0…1 around `at`. */
function impact(t: number, at: number, len = 0.16) {
  return t >= at - 0.03 && t < at + len ? Math.sin(Math.PI * seg(t, at - 0.03, at + len)) : 0;
}

function greetPose(t: number): Pose {
  // Island size — only the spread of the particles uses it.
  const gx = seg(t, 0, 0.5);
  const g = Math.sin((Math.PI * gx) / 2) + 0.04 * Math.sin(Math.PI * gx) * gx;
  const iw = lerp(NOTCH_W, GREETING_W, g);
  const ih = lerp(COMPACT.height, GREETING_H, g);

  const cx = C0.x;
  const cy = C0.y;
  // He grows as he falls out of the notch: 0.35 → 1.
  const hb = t < T.appear ? 0 : lerp(HB * 0.35, HB, E.out(seg(t, T.appear, T.land1)));
  const side = cx - ROLL_DIST;

  // Lateral travel: rolls away, rocks there, rolls back.
  let x = cx;
  if (t >= T.roll0 && t < T.roll1) x = lerp(cx, side, E.inOut(seg(t, T.roll0, T.roll1)));
  else if (t >= T.roll1 && t < T.back0) x = side;
  else if (t >= T.back0 && t < T.back1) x = lerp(side, cx, E.inOut(seg(t, T.back0, T.back1)));
  const wave = t >= T.wave0 && t < T.wave1 ? t - T.wave0 : -1;
  const waveAmp = wave >= 0 ? Math.sin(Math.PI * seg(t, T.wave0, T.wave1)) : 0;
  const rock = Math.sin((wave >= 0 ? wave : 0) * 2 * Math.PI * 1.7) * waveAmp;
  if (wave >= 0) x += rock * HB * 0.05;
  // Rolling without slipping: the face turns by the distance over the radius.
  const roll = (x - cx) / (HB / 2) - (wave >= 0 ? rock * HB * 0.05 / (HB / 2) : 0);

  // Vertical travel: drop, two bounces.
  let y = cy;
  if (t < T.appear) y = COMPACT.centerY;
  else if (t < T.land1) y = lerp(COMPACT.centerY, cy, E.quadIn(seg(t, T.appear, T.land1)));
  else if (t < T.land2) y = cy - 0.36 * HB * arc(seg(t, T.land1, T.land2));
  else if (t < T.land3) y = cy - 0.12 * HB * arc(seg(t, T.land2, T.land3));

  // Squash and stretch: stretched while falling fast, squashed on each landing,
  // a pleased stretch on waking, a crouch before the roll back.
  const fall = t >= T.appear && t < T.land1 ? E.quadIn(seg(t, T.appear, T.land1)) : 0;
  let sx = 1 - 0.1 * fall;
  let sy = 1 + 0.14 * fall;
  for (const [at, k] of [[T.land1, 0.22], [T.land2, 0.14], [T.land3, 0.07]] as const) {
    const s = impact(t, at);
    sx += k * s;
    sy -= k * 0.9 * s;
  }
  const pop = t >= T.pop0 && t < T.pop1 + 0.1 ? Math.sin(Math.PI * seg(t, T.pop0, T.pop1 + 0.1)) : 0;
  sx -= 0.07 * pop;
  sy += 0.1 * pop;
  const crouch = t >= T.wave1 && t < T.back0 + 0.1 ? Math.sin(Math.PI * seg(t, T.wave1, T.back0 + 0.1)) : 0;
  sx += 0.08 * crouch;
  sy -= 0.08 * crouch;
  const settle = Math.sin(Math.PI * seg(t, T.back1 - 0.02, T.back1 + 0.16));
  sx += 0.06 * settle;
  sy -= 0.05 * settle;

  // Eyes: shut as he falls, wake, happy on the stretch and while saying hello.
  let eye: StewEye = "closed";
  if (t >= T.wake) eye = "oval";
  if ((t >= T.pop0 && t < T.pop1 + 0.05) || wave >= 0) eye = "happy";
  const blink = (tb: number) => {
    const k = seg(t, tb, tb + 0.12);
    return k > 0 && k < 1 ? 1 - Math.sin(Math.PI * k) * 0.94 : 1;
  };
  const wakeOpen = t < T.wake ? 0 : E.out(seg(t, T.wake, T.wake + 0.16));
  const open = Math.min(wakeOpen, blink(3.0), blink(T.blink2));

  // Look: up at you on waking, at you while waving, then home.
  let lookX = 0;
  let lookY = 0;
  if (t >= T.wake && t < T.roll0) lookY = 0.45;
  else if (t >= T.roll1 && t < T.back0) { lookX = 0.45; lookY = 0.35; }
  else if (t >= T.back1) {
    const k = E.inOut(seg(t, T.back1, T.back1 + 0.35));
    lookY = lerp(0.15, 0, k);
  }

  const still = reducedMotion();
  return {
    hb, x, y, sx, sy,
    tilt: still ? 0 : rock * 0.18,
    roll: still ? 0 : roll,
    eye, open, lookX, lookY, wave,
    blush: 0.8 * Math.sin(Math.PI * seg(t, T.wave0 - 0.1, T.wave1 + 0.2)),
    halo: E.out(seg(t, 0.3, 0.7)),
    fx: 1,
    header: seg(t, 0.35, 0.6),
    card: seg(t, 0.18, 0.45),
    iw, ih,
  };
}

function smallPose(): Pose {
  return {
    hb: COMPACT_HB,
    x: GREETING_W / 2,
    y: COMPACT_Y,
    sx: 1, sy: 1, tilt: 0, roll: 0,
    eye: "oval", open: 1,
    lookX: 0, lookY: 0, wave: -1,
    blush: 0,
    halo: 0.5,
    fx: 1,
    header: 0, card: 0,
    iw: COMPACT.width, ih: COMPACT.height,
  };
}

/** Stew's pose `t` seconds in; `tc` is when the collapse began (∞ if not yet). */
export function greetingPose(t: number, tc = Number.POSITIVE_INFINITY): Pose {
  if (t < tc) return greetPose(Math.min(t, T.end + 10));
  const a = greetPose(tc);
  const b = smallPose();
  // Same curve and duration (340 ms) as the island shrinking around him, so
  // the island never gets ahead of him and cuts him off.
  const k = seg(t, tc, tc + T.COLLAPSE);
  const e = k >= 1 ? 1 : closeCurve(k);
  const p: Pose = { ...a };
  p.iw = lerp(a.iw, b.iw, e);
  p.ih = lerp(a.ih, b.ih, e);
  p.x = lerp(a.x, b.x, e);
  p.y = lerp(a.y, b.y, e);
  p.hb = lerp(a.hb, b.hb, e);
  p.halo = lerp(a.halo, b.halo, e);
  p.header = a.header * (1 - seg(t, tc, tc + 0.1));
  p.card = a.card * (1 - seg(t, tc, tc + 0.18));
  // Mid-roll, he finishes the turn the short way round.
  const r0 = Math.atan2(Math.sin(a.roll), Math.cos(a.roll));
  p.roll = r0 * (1 - e);
  p.wave = -1;
  p.blush = a.blush * (1 - e);
  p.tilt = a.tilt * (1 - e);
  p.sx = lerp(a.sx, 1, e);
  p.sy = lerp(a.sy, 1, e);
  const bk = seg(t, tc + 0.14, tc + 0.26);
  p.eye = "oval";
  p.open = bk > 0 && bk < 1 ? 1 - Math.sin(Math.PI * bk) * 0.94 : 1;
  p.lookX = a.lookX * (1 - e);
  p.lookY = a.lookY * (1 - e);
  p.fx = 1 - seg(t, tc, tc + 0.2);
  return p;
}

/**
 * Bounding box of Stew in the 640×150 space — what must stay inside the
 * island so nothing of him is cut off. He squashes about his bottom.
 */
export function mochiBounds(p: Pose): { left: number; right: number; top: number; bottom: number } | null {
  const hh = p.hb / 2;
  const hw = hh * ASP;
  if (hh <= 0.4) return null;
  const bottom = p.y + hh;
  return {
    left: p.x - hw * p.sx,
    right: p.x + hw * p.sx,
    top: bottom - 2 * hh * p.sy,
    bottom,
  };
}

// ── Particles (seeded LCG, so every launch looks the same) ───────────────────

interface Puff { a: number; s: number; v: number; al: number }
interface Spark { a: number; v: number; s: number }

const PARTICLES = (() => {
  let seed = 11;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  // A puff of dust along the floor where he lands.
  const puffs: Puff[] = Array.from({ length: 26 }, () => ({
    a: rnd() < 0.5 ? Math.PI - rnd() * 0.5 : rnd() * 0.5,
    s: 1.2 + rnd() * 2.2,
    v: 60 + rnd() * 120,
    al: 0.25 + rnd() * 0.4,
  }));
  // A few sparks around him when he wakes with his stretch.
  const sparks: Spark[] = Array.from({ length: 10 }, (_, i) => ({
    a: -Math.PI / 2 + ((i / 9) - 0.5) * 2.6 + (rnd() - 0.5) * 0.2,
    v: 26 + rnd() * 22,
    s: 1.2 + rnd() * 1.4,
  }));
  return { puffs, sparks };
})();

// ── Drawing ───────────────────────────────────────────────────────────────────

function rr(x: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, R: number) {
  const r = Math.max(0, Math.min(R, W / 2, H / 2));
  x.beginPath();
  x.moveTo(X + r, Y);
  x.arcTo(X + W, Y, X + W, Y + H, r);
  x.arcTo(X + W, Y + H, X, Y + H, r);
  x.arcTo(X, Y + H, X, Y, r);
  x.arcTo(X, Y, X + W, Y, r);
  x.closePath();
}

function drawStewAt(x: CanvasRenderingContext2D, p: Pose) {
  const r = p.hb / 2;
  if (r <= 0.4) return;

  // A soft green halo while he is out in the open.
  if (p.halo > 0) {
    for (const [R, alpha] of [[r * 2.6, 0.14], [r * 4.2, 0.05]] as const) {
      const g = x.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
      g.addColorStop(0, `rgba(150,220,120,${alpha * p.halo})`);
      g.addColorStop(1, "rgba(150,220,120,0)");
      x.fillStyle = g;
      x.beginPath();
      x.arc(p.x, p.y, R, 0, Math.PI * 2);
      x.fill();
    }
  }

  // His contact shadow on the card's floor: smaller and fainter as he lifts.
  let ground = 0;
  if (p.card > 0.05 && p.hb > HB * 0.6) {
    const floor = C0.y + HB / 2;
    const lift = clamp((floor - (p.y + r)) / (HB * 0.5), 0, 1);
    ground = p.card * (1 - lift);
    const w = r * (0.95 - 0.45 * lift);
    x.save();
    x.globalAlpha = p.card * (1 - lift * 0.7) * 0.55;
    x.translate(p.x, floor);
    x.scale(1, 0.18);
    const sg = x.createRadialGradient(0, 0, 0, 0, 0, w);
    sg.addColorStop(0, "rgba(0,0,0,0.9)");
    sg.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = sg;
    x.beginPath();
    x.arc(0, 0, w, 0, Math.PI * 2);
    x.fill();
    x.restore();
  }

  const pose = restPose(r);
  pose.sx = p.sx;
  pose.sy = p.sy;
  pose.tilt = p.tilt;
  pose.roll = p.roll;
  pose.lookX = p.lookX;
  pose.lookY = p.lookY;
  pose.eye = p.eye;
  pose.open = p.open;
  pose.blush = p.blush;
  pose.ground = ground;
  pose.t = performance.now() / 1000;
  x.save();
  x.translate(p.x, p.y);
  drawStew(x, pose);
  x.restore();
}

function drawParticles(x: CanvasRenderingContext2D, t: number, p: Pose) {
  if (!(p.card > 0 || p.fx < 1)) return;
  const floor = C0.y + HB / 2;

  // A short trail while he falls.
  if (t > T.appear && t < T.land1 + 0.1) {
    const fade = 1 - seg(t, T.land1 - 0.05, T.land1 + 0.1);
    const len = Math.min(70, (p.y - 10) * 0.9);
    if (len > 2) {
      const g = x.createLinearGradient(0, p.y - len, 0, p.y - p.hb * 0.3);
      g.addColorStop(0, "rgba(181,231,154,0)");
      g.addColorStop(1, `rgba(181,231,154,${0.4 * fade * p.fx})`);
      x.fillStyle = g;
      x.fillRect(p.x - p.hb * 0.16, p.y - len, p.hb * 0.32, len - p.hb * 0.3);
    }
  }

  // Dust from the first landing.
  const kd = seg(t, T.land1, T.land1 + 0.7);
  if (kd > 0 && kd < 1) {
    for (const d of PARTICLES.puffs) {
      const dist = d.v * E.out(kd) * 0.9;
      const px = C0.x + Math.cos(d.a) * (HB * 0.55 + dist);
      const py = floor - Math.abs(Math.sin(d.a)) * dist * 0.35 - 2;
      x.fillStyle = `rgba(230,240,225,${d.al * (1 - kd) * p.fx * p.card})`;
      x.beginPath();
      x.arc(px, py, d.s * (1 + kd), 0, Math.PI * 2);
      x.fill();
    }
  }

  // Sparks when he wakes and stretches.
  const ks = seg(t, T.pop0, T.pop0 + 0.7);
  if (ks > 0 && ks < 1) {
    for (const s of PARTICLES.sparks) {
      const d = HB * 0.62 + s.v * E.out(ks);
      x.fillStyle = `rgba(214,250,190,${(1 - ks) * 0.9 * p.fx * p.card})`;
      x.beginPath();
      x.arc(C0.x + Math.cos(s.a) * d, C0.y + Math.sin(s.a) * d * 0.8, s.s * (1 - ks * 0.5), 0, Math.PI * 2);
      x.fill();
    }
  }
}

// ── Controller ────────────────────────────────────────────────────────────────

/**
 * Runs the greeting animation on its own canvas. `onComplete` fires once at
 * T.end (or right after the collapse when interrupted) so the FSM can move on.
 */
export class Greeting {
  private startMs = 0;
  private tc = Number.POSITIVE_INFINITY;
  private fired = false;
  private timers: number[] = [];

  onComplete: (() => void) | null = null;

  start() {
    this.startMs = performance.now();
    this.tc = Number.POSITIVE_INFINITY;
    this.fired = false;
    this.cancelTimers();
    // The score plays from the start; it outlives greetComplete a little on
    // purpose and fades when the greeting view goes away (see leave()).
    Sound.play(GREETING_SOUND);
    this.timers.push(window.setTimeout(() => this.fire(), (T.end + 0.05) * 1000));
  }

  /** Mouse entered the island during the greeting — hold it open. */
  hover() {
    if (this.tc >= T.autoLeave) this.tc = Number.POSITIVE_INFINITY;
  }

  /** Mouse left — collapse from now. */
  interrupt() {
    const t = (performance.now() - this.startMs) / 1000;
    if (!Number.isFinite(this.tc) || this.tc > t) this.tc = t;
    this.cancelTimers();
    Sound.fadeOut(GREETING_SOUND, 0.25);
  }

  /** The greeting view is gone: let what is left of its sound fade away. */
  leave() {
    this.cancelTimers();
    Sound.fadeOut(GREETING_SOUND, 0.2);
  }

  get elapsed(): number {
    return (performance.now() - this.startMs) / 1000;
  }

  get done(): boolean {
    return this.fired;
  }

  private fire() {
    if (this.fired) return;
    this.fired = true;
    this.cancelTimers();
    this.onComplete?.();
  }

  private cancelTimers() {
    this.timers.forEach((id) => window.clearTimeout(id));
    this.timers = [];
  }

  draw(x: CanvasRenderingContext2D) {
    const t = this.elapsed;
    if (!this.fired && t >= T.end && this.tc >= T.autoLeave) this.fire();

    const p = greetingPose(t, this.tc);
    x.clearRect(0, 0, GREETING_W, GREETING_H);

    if (p.card > 0) {
      x.save();
      x.globalAlpha = p.card;
      rr(x, CARD.x, CARD.y, CARD.w, CARD.h, CARD_R);
      x.fillStyle = "#141518";
      x.fill();
      x.restore();

      x.save();
      rr(x, CARD.x, CARD.y, CARD.w, CARD.h, CARD_R);
      x.clip();
      drawParticles(x, t, p);
      x.restore();
    } else if (Number.isFinite(this.tc) && t >= this.tc) {
      drawParticles(x, t, p);
    }

    drawStewAt(x, p);
  }
}
