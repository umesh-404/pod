// Stew's engine: state, tweens, springs and particles, drawn with stew.ts.
//
// Stew is a glossy green ball. He has no hands, no ears and no sprout: what
// he feels shows in his eyes and in how his body moves: squash and stretch,
// tilt, rolls, hops, the glow behind him and a few small particles. He hops
// and squashes on landing, rolls a little when poked, rocks while he thinks,
// bobs while he works, flattens and breathes slowly asleep, and wobbles like
// jelly when the pointer comes to him. The light on him never moves: rolls
// turn his face, not his shine (stew.ts).
//
// The public API is the one the island, the desktop window and Settings use:
// setState, triggerEmote, slap, squash, greet, blink, animateMorph,
// setOutfit, setDancing, applyDance, update, draw, busy…

import { Ease, type EaseFn } from "../core/anim";
import { Sound } from "../core/sound";
import type { BotEmoteName, BotStateName } from "../core/layout";
import { drawOutfitFront } from "./outfits";
import type { Outfit } from "./wardrobe";
import {
  PEA_DROP, PEA_SCALE, drawContactShadow, drawStew, heartPath, hex, mixRGB, rgba,
  type RGB, type StewEye, type StewPose,
} from "./stew";

export type { RGB } from "./stew";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EyeShape = StewEye;

export type BadgeKind = "dots" | "bang" | "question" | "dot" | "arrow";

export interface Badge {
  kind: BadgeKind;
  color: RGB;
}

export type TweenKey = readonly [target: number, durationMs: number, ease: EaseFn];

interface Tween {
  prop: PropKey;
  keys: TweenKey[];
  index: number;
  from: number;
  startMs: number;
  onComplete?: () => void;
}

type PropKey =
  | "yaw" | "pitch" | "roll" | "tilt" | "open" | "sx" | "sy"
  | "oy" | "ox" | "tint" | "morph" | "hands" | "blush" | "es" | "badgeS"
  | "outfitPresence" | "mouth" | "shake";

interface BotStateCfg {
  color: RGB;
  tint: number;
  eye: EyeShape;
  badge: Badge | null;
  bounces: boolean;
  scans: boolean;
  breathes: boolean;
  zz: boolean;
  sweat: boolean;
  look: readonly [number, number] | null;
  tilt: number;
  /** A small busy bob (working), × R. */
  bob: number;
  /** A slow rock from side to side (thinking), radians. */
  rock: number;
}

interface Particle {
  type: "heart" | "star" | "spark" | "sweat" | "z";
  x: number; y: number; vx: number; vy: number;
  age: number; life: number; rot: number; size: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** His radius as a fraction of the slot radius R (= W × 0.3), and how low he sits. */
const PEA = PEA_SCALE;
const DROP = PEA_DROP;

const C = {
  idle: [0.486, 0.769, 0.416] as RGB,
  working: [0.231, 0.62, 1] as RGB,
  thinking: [0.545, 0.361, 0.965] as RGB,
  searching: [0.388, 0.396, 0.949] as RGB,
  approval: [0.961, 0.647, 0.141] as RGB,
  question: [0.133, 0.827, 0.933] as RGB,
  error: [0.957, 0.314, 0.369] as RGB,
  finished: [0.204, 0.831, 0.6] as RGB,
  ratelimit: [0.984, 0.573, 0.235] as RGB,
  sleeping: [0.58, 0.635, 0.722] as RGB,
  dizzy: [0.957, 0.447, 0.714] as RGB,
};

const base = {
  bounces: false, scans: false, breathes: false, zz: false, sweat: false,
  look: null, tilt: 0, bob: 0, rock: 0,
};

export const BOT_STATES: Record<BotStateName, BotStateCfg> = {
  idle: { ...base, color: C.idle, tint: 0, eye: "oval", badge: null },
  working: { ...base, color: C.working, tint: 0.6, eye: "oval", badge: { kind: "dots", color: C.working }, bob: 0.035 },
  thinking: { ...base, color: C.thinking, tint: 0.6, eye: "oval", badge: { kind: "dots", color: C.thinking }, look: [0.55, 0.55], rock: 0.08 },
  searching: { ...base, color: C.searching, tint: 0.6, eye: "oval", badge: { kind: "dots", color: C.searching }, scans: true },
  approval: { ...base, color: C.approval, tint: 0.66, eye: "wide", badge: { kind: "bang", color: C.approval }, bounces: true },
  question: { ...base, color: C.question, tint: 0.62, eye: "oval", badge: { kind: "question", color: C.question }, tilt: 0.17 },
  error: { ...base, color: C.error, tint: 0.66, eye: "flat", badge: { kind: "dot", color: C.error } },
  finished: { ...base, color: C.finished, tint: 0.3, eye: "happy", badge: { kind: "dot", color: C.finished } },
  ratelimit: { ...base, color: C.ratelimit, tint: 0.6, eye: "tired", badge: { kind: "dot", color: C.ratelimit }, sweat: true },
  sleeping: { ...base, color: C.sleeping, tint: 0.28, eye: "closed", badge: null, breathes: true, zz: true },
  dizzy: { ...base, color: C.dizzy, tint: 0.6, eye: "dizzy", badge: null },
};

/** State → sound. */
export const STATE_SOUND: Partial<Record<BotStateName, string>> = {
  working: "work", thinking: "think", searching: "search", approval: "approval",
  question: "question", error: "error", finished: "finish", ratelimit: "rate",
  sleeping: "sleep", dizzy: "dizzy",
};

const EMOTE_EYE: Record<BotEmoteName, EyeShape> = {
  love: "love", surprised: "dot", proud: "sparkle", wink: "wink",
  yawn: "tired", happy: "happy", annoyed: "annoyed",
};

// ── Small helpers ─────────────────────────────────────────────────────────────

const now = () => performance.now() / 1000;

export function hexToRGB(h: string): RGB {
  return hex(h);
}

function roundRectPath(x: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, R: number) {
  const r = Math.max(0, Math.min(R, W / 2, H / 2));
  x.beginPath();
  x.moveTo(X + r, Y);
  x.arcTo(X + W, Y, X + W, Y + H, r);
  x.arcTo(X + W, Y + H, X, Y + H, r);
  x.arcTo(X, Y + H, X, Y, r);
  x.arcTo(X, Y, X + W, Y, r);
  x.closePath();
}

function starPath(x: CanvasRenderingContext2D, ro: number, ri: number) {
  x.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? ri : ro;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    x.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  x.closePath();
}

const FONT = `system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif`;

let reducedQuery: MediaQueryList | null | undefined;
/** prefers-reduced-motion: no rolls, rocking or shaking — only the poses. */
function reducedMotion(): boolean {
  if (reducedQuery === undefined) {
    try {
      reducedQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    } catch {
      reducedQuery = null;
    }
  }
  return reducedQuery?.matches ?? false;
}

// ── Dance ─────────────────────────────────────────────────────────────────────

/** The dance fades in over 0.3 s and out over 0.5 s. */
export function stepDanceLevel(level: number, dancing: boolean, dt: number): number {
  const target = dancing ? 1 : 0;
  if (level < target) return Math.min(target, level + dt / 0.3);
  if (level > target) return Math.max(target, level - dt / 0.5);
  return level;
}

/**
 * The 112-BPM bounce at `seconds`, for a body of radius R and a dance `level`
 * (0…1): a ball bouncing on the beat, rocking side to side, squashing on each
 * landing.
 */
export function danceTransform(seconds: number, level: number, R: number) {
  const beat = (seconds * 112) / 60;
  const hop = Math.abs(Math.sin(Math.PI * beat));
  const land = Math.pow(1 - hop, 6);
  return {
    dx: 0.05 * R * Math.sin(Math.PI * beat * 0.5) * level,
    dy: -0.16 * R * hop * level,
    rotate: 0.14 * Math.sin(Math.PI * beat * 0.5) * level,
    sx: 1 + 0.07 * land * level,
    sy: 1 - 0.08 * land * level,
  };
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class BotEngine {
  /** Solid body colour (the update blue, the Pod window's tinted Stews); null = Stew green. */
  bodyColor: RGB | null = null;
  /**
   * A new Pod waits (whats-new/whats-new.ts): while Stew is idle or asleep
   * he wears the up-arrow badge. The island turns him blue alongside.
   */
  private updateHint: RGB | null = null;

  // Animated state
  yaw = 0; pitch = 0; roll = 0; tilt = 0; open = 1;
  sx = 1; sy = 1; oy = 0; ox = 0;
  tint = 0; morph = 0; hands = 0; blush = 0; es = 1; badgeS = 0;
  /** A short shake (annoyed), 0…1. */
  shake = 0;
  /** The little "o", 0…1. */
  mouth = 0;

  // Accessory. `outfit` is what is drawn; it changes only once the previous one has left.
  outfit: Outfit = "none";
  /** 0 = gone, 1 = fully on. */
  outfitPresence = 0;
  private outfitTarget: Outfit = "none";

  // Spring lag of the soft parts (scarf end, pompom) and of his dangle when carried, −1…1.
  physDx = 0;
  physDy = 0;
  private physVx = 0;
  private physVy = 0;
  private prevYaw = 0;
  private prevOy = 0;
  private prevRoll = 0;

  // Hover wobble (a soft jelly spring on the squash).
  private wob = 0;
  private wobV = 0;
  private prevTgEs = 1;

  // Targets
  tgYaw = 0; tgPitch = 0; tgTilt = 0; tgSy = 1; tgSx = 1; tgEs = 1;

  /** Extra canvas height above the body so hearts can fly out without clipping. */
  particleOverhang = 0;
  /** Drawn all the time by its host (desktop, Pod window). */
  ambient = false;
  /** Sitting on something (the desktop): a faint contact shadow under him. */
  groundShadow = false;
  /** Picked up and carried (desktop drag). */
  private carried = false;

  /** Dancing to music; `dancingLevel` follows it, 0→1 in 0.3 s, 1→0 in 0.5 s. */
  isDancing = false;
  dancingLevel = 0;

  // Mouth spring for the drop "catch" (fraction of R)
  slotH = 0; slotHTarget = 0; slotHVel = 0; isChewing = false;

  col: RGB = C.idle;
  colT: RGB = C.idle;

  state: BotStateName = "idle";
  cfg: BotStateCfg = BOT_STATES.idle;

  eyeOverride: EyeShape | null = null;
  eyeOverrideUntil = 0;

  badge: Badge | null = null;
  private badgeKey = "none";
  private badgeToken = 0;

  private tweens = new Map<PropKey, Tween>();
  private locks = new Set<PropKey>();
  private particles: Particle[] = [];

  lookX = 0;
  lookY = 0;

  lastTime = now();
  private t0 = now() - Math.random() * 5;
  private nextBlink = now() + 1.5 + Math.random() * 2;
  waveUntil = 0;
  waveStart = 0;
  private greetToken = 0;
  private lastAmbient = 0;
  private slapTimes: number[] = [];

  /** Fired when three slaps land inside 1.7 s (→ dizzy + confused view). */
  onDizzy: (() => void) | null = null;

  // ── Public API ──────────────────────────────────────────────────────────────

  setState(next: BotStateName, force = false) {
    if (this.state === next && !force) return;
    const prev = this.state;
    this.state = next;
    this.cfg = BOT_STATES[next];
    this.colT = this.cfg.color;
    if (!this.locks.has("tint")) this.tint = this.cfg.tint;
    if (!this.locks.has("tilt")) this.tgTilt = this.cfg.tilt;
    this.setBadge(this.stateBadge());
    const still = reducedMotion();

    switch (next) {
      case "finished":
        // A pleased hop with a somersault: he rolls once round, the light stays.
        this.hop(0.24);
        if (!still) this.anim("roll", [[Math.PI * 2, 620, Ease.inOut]], () => { this.roll = 0; });
        setTimeout(() => this.emit("spark", 4), 380);
        break;
      case "error":
        // He sinks and shivers.
        this.anim("sy", [[0.86, 120, Ease.out], [0.94, 260, Ease.inOut], [1, 300, Ease.inOut]]);
        this.anim("sx", [[1.1, 120, Ease.out], [1.04, 260, Ease.inOut], [1, 300, Ease.inOut]]);
        if (!still) {
          this.anim("ox", [
            [0.04, 40, Ease.out], [-0.04, 50, Ease.inOut], [0.03, 50, Ease.inOut],
            [-0.02, 50, Ease.inOut], [0, 60, Ease.out],
          ]);
        }
        break;
      case "approval":
        // Stands up tall: look at me.
        this.anim("sy", [[1.14, 140, Ease.out], [1, 320, Ease.back]]);
        this.anim("sx", [[0.9, 140, Ease.out], [1, 320, Ease.back]]);
        break;
      case "dizzy":
        // Rocks like a top running down.
        this.anim("tilt", [
          [0.34, 130, Ease.out], [-0.28, 220, Ease.inOut], [0.2, 220, Ease.inOut],
          [-0.12, 220, Ease.inOut], [0.05, 200, Ease.inOut], [0, 220, Ease.out],
        ]);
        break;
      case "question":
        this.blink();
        break;
      case "ratelimit":
        this.emit("sweat", 1);
        break;
      case "sleeping":
        // Curls up: a slow settle, a little flatter.
        this.anim("sy", [[0.9, 500, Ease.inOut], [0.95, 400, Ease.inOut]]);
        this.anim("sx", [[1.08, 500, Ease.inOut], [1.04, 400, Ease.inOut]]);
        break;
      default:
        if (prev !== "idle" || next !== "idle") this.blink();
    }
  }

  /** The update badge (blue arrow) while one waits, else nothing. Asked every frame; cheap. */
  setUpdateHint(color: RGB | null) {
    const was = this.updateHint;
    const same = color === was || (color != null && was != null && color.every((c, i) => c === was[i]));
    if (same) return;
    this.updateHint = color;
    this.setBadge(this.stateBadge());
  }

  /** Whether the update hint shows now: only over an idle or sleeping Stew. */
  get showsUpdateHint(): boolean {
    return this.updateHint != null && (this.state === "idle" || this.state === "sleeping");
  }

  private stateBadge(): Badge | null {
    if (this.showsUpdateHint && this.updateHint) return { kind: "arrow", color: this.updateHint };
    return this.cfg.badge;
  }

  setBadge(b: Badge | null) {
    const key = b ? `${b.kind}-${b.color.join(",")}` : "none";
    if (key === this.badgeKey) return;
    this.badgeKey = key;
    const tok = ++this.badgeToken;
    this.anim("badgeS", [[0, 90, Ease.inOut]]);
    setTimeout(() => {
      if (tok !== this.badgeToken) return;
      this.badge = b;
      if (b) this.anim("badgeS", [[1, 280, Ease.back]]);
    }, 100);
  }

  blink() {
    if (this.locks.has("open")) return;
    this.anim("open", [[0.05, 60, Ease.inOut], [1, 120, Ease.out]]);
  }

  /** Lands: squash wide, stretch, settle. */
  squash() {
    this.physVy += 0.6;
    this.physVx += (Math.random() - 0.5) * 0.6;
    this.anim("sy", [[0.8, 70, Ease.out], [1.08, 130, Ease.out], [1, 170, Ease.inOut]]);
    this.anim("sx", [[1.18, 70, Ease.out], [0.96, 130, Ease.out], [1, 170, Ease.inOut]]);
  }

  /** A small hop of `height` (× R), landing with a squash. */
  private hop(height: number) {
    this.anim("oy", [[-height, 170, Ease.out], [0, 190, Ease.easeIn]], () => this.squash());
    this.anim("sy", [[1.1, 120, Ease.out], [1, 200, Ease.inOut]]);
    this.anim("sx", [[0.93, 120, Ease.out], [1, 200, Ease.inOut]]);
  }

  /** Swallows what was dropped: mouth wide, a gulp, a happy squash. */
  gulp() {
    this.slotHTarget = 0.42;
    setTimeout(() => {
      this.slotHTarget = 0;
      this.isChewing = true;
      setTimeout(() => { this.isChewing = false; }, 800);
    }, 460);
    this.anim("sy", [[0.8, 80, Ease.out], [1.16, 130, Ease.out], [1, 220, Ease.back]]);
    this.anim("sx", [[1.24, 80, Ease.out], [0.92, 130, Ease.out], [1, 220, Ease.back]]);
    this.blink();
  }

  /** Poked: he rolls a little away from it, rocks back, and frowns. */
  slap() {
    this.interruptGreet();
    if (this.state === "dizzy") return;
    const t = now();
    this.slapTimes = this.slapTimes.filter((s) => t - s < 1.7);
    this.slapTimes.push(t);
    Sound.play("slap");
    const sd = Math.random() < 0.5 ? 1 : -1;
    this.squash();
    if (!reducedMotion()) {
      this.anim("roll", [[sd * 0.6, 130, Ease.out], [-sd * 0.12, 260, Ease.inOut], [0, 260, Ease.inOut]]);
      this.anim("ox", [[sd * 0.16, 130, Ease.out], [-sd * 0.03, 260, Ease.inOut], [0, 260, Ease.inOut]]);
    }
    this.physVx -= sd * 1.4;
    if (this.slapTimes.length >= 3) {
      this.slapTimes = [];
      this.onDizzy?.();
    } else {
      this.eyeOverride = "annoyed";
      this.eyeOverrideUntil = t + 0.8;
      setTimeout(() => Sound.play("annoyed"), 60);
    }
  }

  /** Rolls all the way round `turns` times (a ball rolling on the spot). */
  doRoll(durationMs: number, turns: number) {
    if (reducedMotion()) return;
    this.roll = 0;
    this.anim("roll", [[Math.PI * 2 * turns, durationMs, Ease.inOut]], () => { this.roll = 0; });
  }

  /** Hello: a hop, then he rocks side to side, beaming. */
  greet() {
    const t = now();
    const tok = ++this.greetToken;
    this.waveStart = t + 0.3;
    this.waveUntil = t + 1.5;
    this.physVx += 0.3;

    this.eyeOverride = "happy";
    this.eyeOverrideUntil = t + 1.9;
    this.anim("blush", [[0.5, 300, Ease.out], [0.5, 900, Ease.lin], [0, 300, Ease.inOut]]);

    setTimeout(() => {
      if (this.greetToken !== tok) return;
      this.hop(0.12);
      this.anim("hands", [[1, 220, Ease.out]]);
      Sound.play("greet");
    }, 200);
    setTimeout(() => { if (this.greetToken === tok) this.blink(); }, 1400);
    setTimeout(() => {
      if (this.greetToken !== tok) return;
      this.waveUntil = 0;
      this.anim("hands", [[0, 220, Ease.inOut]]);
    }, 1500);
  }

  interruptGreet() {
    if (this.hands <= 0.01 && now() >= this.waveUntil) return;
    this.greetToken++;
    this.waveUntil = 0;
    this.waveStart = 0;
    this.anim("hands", [[0, 150, Ease.inOut]]);
  }

  triggerEmote(emote: BotEmoteName, duration = 1.8) {
    const t = now();
    this.eyeOverride = EMOTE_EYE[emote];
    this.eyeOverrideUntil = t + duration;
    const hold = Math.max(0, (duration - 0.6) * 1000);
    const still = reducedMotion();

    switch (emote) {
      case "love":
        // Blushes, melts a little (a soft wobble), hearts float up.
        this.anim("blush", [[1, 300, Ease.out], [1, hold, Ease.lin], [0, 300, Ease.inOut]]);
        this.emit("heart", 3);
        this.hop(0.08);
        if (!still) this.wobV += 5;
        break;
      case "surprised":
        // Jumps, stretched tall, eyes wide, a little "o".
        this.anim("oy", [[-0.26, 130, Ease.out], [0, 360, Ease.back]]);
        this.anim("sy", [[1.12, 130, Ease.out], [1, 360, Ease.back]]);
        this.anim("sx", [[0.92, 130, Ease.out], [1, 360, Ease.back]]);
        this.anim("es", [[1.22, 110, Ease.out], [1, 500, Ease.inOut]]);
        this.anim("mouth", [[1, 120, Ease.out], [1, hold * 0.6, Ease.lin], [0, 260, Ease.inOut]]);
        break;
      case "proud":
        // Puffs up, chin up, a few sparkles.
        this.emit("star", 3);
        this.anim("sx", [[1.08, 240, Ease.out], [1.08, hold, Ease.lin], [1, 280, Ease.inOut]]);
        this.anim("sy", [[1.08, 240, Ease.out], [1.08, hold, Ease.lin], [1, 280, Ease.inOut]]);
        this.anim("tilt", [[-0.1, 220, Ease.out], [-0.1, hold, Ease.lin], [0, 280, Ease.inOut]]);
        this.anim("pitch", [[0.25, 220, Ease.out], [0.25, hold, Ease.lin], [this.tgPitch, 280, Ease.inOut]]);
        break;
      case "wink":
        this.anim("tilt", [[0.12, 160, Ease.out], [0.12, (duration - 0.4) * 1000, Ease.lin], [0, 240, Ease.inOut]]);
        this.physVx += 0.8;
        break;
      case "yawn":
        // Stretches tall with a big "o", then sags and nods off a moment.
        this.anim("sy", [[1.14, 500, Ease.inOut], [0.96, 450, Ease.inOut], [1, 300, Ease.inOut]]);
        this.anim("sx", [[0.92, 500, Ease.inOut], [1.04, 450, Ease.inOut], [1, 300, Ease.inOut]]);
        this.anim("mouth", [[1.3, 450, Ease.inOut], [0, 350, Ease.inOut]]);
        setTimeout(() => { this.eyeOverride = "closed"; this.emit("z", 2); }, 700);
        break;
      case "happy":
        this.anim("blush", [[0.6, 200, Ease.out], [0, 600, Ease.inOut]]);
        this.hop(0.1);
        break;
      case "annoyed":
        // Frowns and gives a short, cross shake.
        this.eyeOverride = "annoyed";
        this.eyeOverrideUntil = t + 0.8;
        if (!still) this.anim("shake", [[1, 40, Ease.out], [1, 300, Ease.lin], [0, 160, Ease.out]]);
        setTimeout(() => Sound.play("annoyed"), 60);
        break;
    }
  }

  emit(type: Particle["type"], count: number) {
    if (reducedMotion()) count = Math.min(count, 1);
    for (let i = 0; i < count; i++) {
      const isZ = type === "z";
      this.particles.push({
        type,
        x: (Math.random() - 0.5) * 0.9 + (isZ ? 0.55 : 0),
        y: -0.7 - Math.random() * 0.2,
        vx: (Math.random() - 0.5) * 0.35 + (isZ ? 0.18 : 0),
        vy: -(0.45 + Math.random() * 0.35),
        age: -i * 0.14,
        life: 1.3 + Math.random() * 0.5,
        rot: Math.random() * Math.PI * 2,
        size: 0.15 + Math.random() * 0.08,
      });
    }
  }

  /** Files dragged over the island: he gets ready to catch them (mouth open, looking up). */
  animateMorph(target: number, durationMs?: number) {
    const dur = durationMs ?? (target > 0.5 ? 380 : 450);
    this.anim("morph", [[target, dur, Ease.inOut]]);
  }

  resetMorph() {
    this.tweens.delete("morph");
    this.locks.delete("morph");
    this.morph = 0;
  }

  /**
   * Dresses Stew. Animated: the old accessory leaves (180 ms), the new one
   * drops in (350 ms) and Stew does a little squash.
   */
  setOutfit(next: Outfit, animated = true) {
    if (next === this.outfitTarget) return;
    this.outfitTarget = next;
    this.tweens.delete("outfitPresence");
    this.locks.delete("outfitPresence");
    const enter = () => {
      this.outfit = next;
      this.anim("outfitPresence", [[1, 350, Ease.inOut]], () => this.squash());
    };
    if (!animated) {
      this.outfit = next;
      this.outfitPresence = next !== "none" ? 1 : 0;
    } else if (next === "none") {
      this.anim("outfitPresence", [[0, 180, Ease.inOut]], () => { this.outfit = "none"; });
    } else if (this.outfit === "none") {
      this.outfitPresence = 0;
      enter();
    } else {
      this.anim("outfitPresence", [[0, 180, Ease.inOut]], enter);
    }
  }

  /** Picked up (desktop drag): he dangles, surprised; put down, he lands with a squash. */
  setCarried(on: boolean) {
    if (on === this.carried) return;
    this.carried = on;
    if (on) {
      this.triggerEmote("surprised", 0.9);
    } else {
      this.squash();
    }
  }

  /** True while anything is still moving — lets the island stop its RAF loop. */
  get busy(): boolean {
    return (
      this.tweens.size > 0 ||
      this.particles.length > 0 ||
      this.cfg.bounces || this.cfg.scans || this.cfg.breathes || this.cfg.zz || this.cfg.sweat ||
      ((this.cfg.bob > 0 || this.cfg.rock > 0) && !reducedMotion()) ||
      this.isDancing || this.dancingLevel > 0.001 || this.carried ||
      Math.abs(this.tgYaw - this.yaw) > 0.002 ||
      Math.abs(this.tgPitch - this.pitch) > 0.002 ||
      Math.abs(this.tgTilt - this.tilt) > 0.002 ||
      Math.abs(this.tgSy - this.sy) > 0.002 ||
      Math.abs(this.tgSx - this.sx) > 0.002 ||
      Math.abs(this.tgEs - this.es) > 0.002 ||
      this.slotH > 0.001 || Math.abs(this.slotHVel) > 0.001 ||
      Math.abs(this.col[0] - this.colT[0]) > 0.003 ||
      Math.abs(this.col[1] - this.colT[1]) > 0.003 ||
      Math.abs(this.col[2] - this.colT[2]) > 0.003 ||
      Math.abs(this.physVx) > 0.01 || Math.abs(this.physVy) > 0.01 ||
      Math.abs(this.physDx) > 0.01 || Math.abs(this.physDy) > 0.01 ||
      Math.abs(this.wob) > 0.003 || Math.abs(this.wobV) > 0.01
    );
  }

  // ── Tweens ──────────────────────────────────────────────────────────────────

  anim(prop: PropKey, keys: TweenKey[], onComplete?: () => void) {
    this.tweens.set(prop, {
      prop, keys, index: 0, from: this[prop], startMs: performance.now(), onComplete,
    });
    this.locks.add(prop);
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  update(dt: number) {
    const n = now();
    const nowMs = performance.now();
    const still = reducedMotion();

    for (const tw of [...this.tweens.values()]) {
      const k = tw.keys[tw.index];
      const p = k[1] <= 0 ? 1 : Math.min(1, Math.max(0, (nowMs - tw.startMs) / k[1]));
      this[tw.prop] = tw.from + (k[0] - tw.from) * k[2](p);
      if (p >= 1) {
        tw.from = k[0];
        tw.index += 1;
        tw.startMs = nowMs;
        if (tw.index >= tw.keys.length) {
          this.tweens.delete(tw.prop);
          this.locks.delete(tw.prop);
          tw.onComplete?.();
        }
      }
    }

    const t = n - this.t0;
    let ty = this.lookX * 0.62;
    let tp = this.lookY * 0.5;

    if (this.cfg.look) {
      ty = ty * 0.35 + this.cfg.look[0] * 0.55;
      tp = tp * 0.3 + this.cfg.look[1] * 0.5;
    }
    if (this.cfg.scans) {
      ty = Math.sin(t * 2.6) * 0.6;
      tp = -0.06;
    }
    if (this.state === "sleeping") { ty = 0; tp = -0.2; }
    if (this.state === "dizzy") { ty = Math.sin(t * 9) * 0.2; }

    this.tgYaw = ty;
    this.tgPitch = tp;
    this.tgTilt = this.cfg.tilt;

    const bounce = this.cfg.bounces ? -Math.abs(Math.sin(t * 5.2)) * 0.07 : 0;
    const kGen = 1 - Math.pow(0.0008, dt);
    if (!this.locks.has("oy")) this.oy += (bounce - this.oy) * kGen;

    if (this.cfg.breathes) {
      // Asleep: curled a little flatter, breathing slowly.
      const b = Math.sin(t * 1.5);
      this.tgSy = 0.95 + b * 0.03;
      this.tgSx = 1.04 - b * 0.018;
    } else if (this.carried) {
      // Dangling from the pointer: a bit stretched.
      this.tgSy = 1.08;
      this.tgSx = 0.94;
    } else {
      this.tgSy = 1;
      this.tgSx = 1;
    }

    const kLook = 1 - Math.pow(0.0025, dt);
    if (!this.locks.has("yaw")) this.yaw += (this.tgYaw - this.yaw) * kLook;
    if (!this.locks.has("pitch")) this.pitch += (this.tgPitch - this.pitch) * kLook;
    if (!this.locks.has("tilt")) this.tilt += (this.tgTilt - this.tilt) * kGen;
    if (!this.locks.has("sy")) this.sy += (this.tgSy - this.sy) * kGen;
    if (!this.locks.has("sx")) this.sx += (this.tgSx - this.sx) * kGen;
    if (!this.locks.has("es")) this.es += (this.tgEs - this.es) * kGen;

    this.col = mixRGB(this.col, this.colT, 1 - Math.pow(0.002, dt));

    if (n > this.nextBlink) {
      if (this.state !== "sleeping" && this.state !== "dizzy") {
        this.blink();
        if (Math.random() < 0.22) setTimeout(() => this.blink(), 230);
      }
      this.nextBlink = n + 2.2 + Math.random() * 3.2;
    }

    if (this.eyeOverride && n > this.eyeOverrideUntil) this.eyeOverride = null;

    if (n - this.lastAmbient > 1.3) {
      this.lastAmbient = n;
      if (this.cfg.zz) this.emit("z", 1);
      if (this.cfg.sweat && Math.random() < 0.5) this.emit("sweat", 1);
    }

    for (const p of this.particles) p.age += dt;
    this.particles = this.particles.filter((p) => p.age < p.life);

    // Mouth spring — ω₀ = 2π/0.25, ζ = 0.6
    const omega = (2 * Math.PI) / 0.25;
    const zeta = 0.6;
    const acc = omega * omega * (this.slotHTarget - this.slotH) - 2 * zeta * omega * this.slotHVel;
    this.slotHVel += acc * dt;
    this.slotH = Math.max(0, this.slotH + this.slotHVel * dt);

    this.dancingLevel = stepDanceLevel(this.dancingLevel, this.isDancing, dt);

    // Hover: a soft wobble when the eyes widen for the pointer.
    if (this.tgEs > 1.02 && this.prevTgEs <= 1.02 && !still) {
      this.wobV += 7;
      this.physVx += 0.8;
    }
    this.prevTgEs = this.tgEs;
    if (dt > 0) {
      this.wobV += (-260 * this.wob - 7 * this.wobV) * dt;
      this.wob += this.wobV * dt;
      if (Math.abs(this.wob) < 0.003 && Math.abs(this.wobV) < 0.01) { this.wob = 0; this.wobV = 0; }
    }

    // Soft-part spring: lags behind turns, hops and rolls (stiffness 60, damping 7).
    // It swings the scarf's end and the pompom, and his dangle when carried.
    if (dt > 0) {
      const yawVel = (this.yaw - this.prevYaw) / dt;
      const oyVel = (this.oy - this.prevOy) / dt;
      const dRoll = this.roll - this.prevRoll;
      const rollVel = Math.abs(dRoll) > Math.PI ? 0 : dRoll / dt;
      const tDx = Math.max(-1, Math.min(1, -yawVel * 0.35 - rollVel * 0.12));
      const tDy = Math.max(-1, Math.min(1, oyVel * 0.5));
      this.physVx += (60 * (tDx - this.physDx) - 7 * this.physVx) * dt;
      this.physVy += (60 * (tDy - this.physDy) - 7 * this.physVy) * dt;
      this.physDx += this.physVx * dt;
      this.physDy += this.physVy * dt;
      if (Math.abs(this.physDx) < 0.002 && Math.abs(this.physVx) < 0.005 && tDx === 0) { this.physDx = 0; this.physVx = 0; }
      if (Math.abs(this.physDy) < 0.002 && Math.abs(this.physVy) < 0.005 && tDy === 0) { this.physDy = 0; this.physVy = 0; }
    }
    this.prevYaw = this.yaw;
    this.prevOy = this.oy;
    this.prevRoll = this.roll;

    this.lastTime = n;
  }

  // ── Dancing ─────────────────────────────────────────────────────────────────

  setDancing(dancing: boolean) {
    if (this.isDancing !== dancing) this.isDancing = dancing;
  }

  /**
   * Applies the dance bounce and rock around his bottom. Call it on
   * a saved context, before draw(), with the same size.
   */
  applyDance(x: CanvasRenderingContext2D, W: number, H: number) {
    if (this.dancingLevel <= 0.001 || reducedMotion()) return;
    const R = W * 0.3;
    const px = W / 2 + this.ox * R;
    const py = H / 2 + this.particleOverhang / 2 + this.oy * R + R * DROP + R * PEA;
    const d = danceTransform(now(), this.dancingLevel, R);
    x.translate(px + d.dx, py + d.dy);
    x.rotate(d.rotate);
    x.scale(d.sx, d.sy);
    x.translate(-px, -py);
  }

  // ── Draw ────────────────────────────────────────────────────────────────────

  /** The eyes he shows now. */
  private eyeShape(): EyeShape {
    let shape: EyeShape = this.eyeOverride ?? this.cfg.eye;
    if (this.isDancing && this.dancingLevel > 0.15 && (this.state === "idle" || this.state === "finished")) {
      shape = "happy";
    }
    if (this.morph > 0.5) {
      if (this.isChewing) shape = "happy";
      else if (shape === "oval") shape = "wide";
    }
    return shape;
  }

  /**
   * Draws Stew, his badge and particles into a canvas of `W`×`H` CSS pixels
   * (the caller has already applied the DPR transform). The slot is W × 0.6
   * wide; he fills 90 % of it.
   */
  draw(x: CanvasRenderingContext2D, W: number, H: number) {
    const R = W * 0.3;
    const r = R * PEA;
    const cx = W / 2 + this.ox * R;
    const restCy = H / 2 + this.particleOverhang / 2 + R * DROP;
    const cy = restCy + this.oy * R;
    const t = now() - this.t0;
    const still = reducedMotion();

    if (this.groundShadow) {
      drawContactShadow(x, W / 2, restCy + r * 1.02, r, Math.min(1, Math.max(0, -this.oy * 2.2)) + (this.carried ? 0.6 : 0));
    }

    const m = this.morph;
    const wobble = this.wob;
    // Working: a small busy bob. Thinking: a slow rock. Hello (`hands`): a
    // happy side-to-side rock. Annoyed: a quick shake. Carried: he dangles.
    const bob = still ? 0 : -Math.abs(Math.sin(t * 5)) * this.cfg.bob;
    const rock = still ? 0 : Math.sin(t * 1.4) * this.cfg.rock;
    const wave = still ? 0 : Math.sin(t * 9) * 0.16 * this.hands;
    const shake = still ? 0 : Math.sin(t * 46) * 0.035 * this.shake;
    const dangle = this.carried ? this.physDx * 0.25 : 0;
    const cyDrawn = cy + bob * R;

    const pose: StewPose = {
      r,
      sx: this.sx * (1 + wobble * 0.06) * (1 + 0.05 * m),
      sy: this.sy * (1 - wobble * 0.06) * (1 - 0.03 * m),
      tilt: this.tilt + rock + wave + dangle,
      roll: this.roll,
      lookX: Math.max(-1, Math.min(1, this.yaw / 0.6)),
      lookY: Math.max(-1, Math.min(1, this.pitch / 0.5 + 0.55 * m)),
      eye: this.eyeShape(),
      open: this.open,
      es: this.es,
      mouth: Math.max(this.mouth, m > 0.3 ? Math.min(1.3, this.slotH * 3.2) : 0),
      blush: this.blush,
      color: this.bodyColor,
      wash: this.col,
      washA: this.tint * (1 - m * 0.5),
      ground: this.groundShadow ? Math.max(0, 1 + this.oy * 4) * (this.carried ? 0 : 1) : 0,
      t,
    };

    const outfit = this.outfit;
    const st = { presence: this.outfitPresence, swing: this.physDx };
    x.save();
    x.translate(cx + shake * R, cyDrawn);
    drawStew(x, pose, outfit === "none" ? {} : {
      front: (c, g) => drawOutfitFront(c, outfit, g, st),
    });
    x.restore();

    if (this.badge && this.badgeS > 0.01 && m < 0.25) {
      this.drawBadge(x, this.badge, R, cx - R * 0.74 * this.sx, cy - R * 0.62 * this.sy);
    }
    this.drawParticles(x, R, cx, cy);
  }

  private drawBadge(x: CanvasRenderingContext2D, badge: Badge, R: number, bx: number, by: number) {
    const bs = this.badgeS;
    const t = now();
    // Tiny Stew (notch, pill): the badge keeps a size that still reads.
    const Rb = Math.max(R, 9);

    x.save();
    x.translate(bx, by);
    x.scale(bs, bs);
    const col = rgba(badge.color);

    if (badge.kind === "dots") {
      const pw = Rb * 0.72;
      const ph = Rb * 0.36;
      roundRectPath(x, -pw / 2, -ph / 2, pw, ph, ph / 2);
      x.lineWidth = Math.max(1, Rb * 0.07);
      x.strokeStyle = "#000";
      x.stroke();
      x.fillStyle = col;
      x.fill();
      for (let i = 0; i < 3; i++) {
        const phase = (((t * 2.4 - i * 0.22) % 1) + 1) % 1;
        const dotR = Rb * 0.055 * (1 + 0.4 * Math.max(0, Math.sin(phase * Math.PI * 2)));
        x.fillStyle = "#fff";
        x.beginPath();
        x.arc((i - 1) * Rb * 0.18, 0, dotR, 0, Math.PI * 2);
        x.fill();
      }
    } else if (badge.kind === "arrow") {
      // A disc with a white up-arrow: a new Pod is out.
      x.fillStyle = "#000";
      x.beginPath();
      x.arc(0, 0, Rb * 0.3, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = col;
      x.beginPath();
      x.arc(0, 0, Rb * 0.23, 0, Math.PI * 2);
      x.fill();
      const a = Rb * 0.12;
      x.strokeStyle = "#fff";
      x.lineWidth = Rb * 0.055;
      x.lineCap = "round";
      x.lineJoin = "round";
      x.beginPath();
      x.moveTo(0, a);
      x.lineTo(0, -a);
      x.moveTo(-a * 0.8, -a * 0.2);
      x.lineTo(0, -a);
      x.lineTo(a * 0.8, -a * 0.2);
      x.stroke();
    } else if (badge.kind === "bang" || badge.kind === "question") {
      x.fillStyle = "#000";
      x.beginPath();
      x.arc(0, 0, Rb * 0.3, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = col;
      x.beginPath();
      x.arc(0, 0, Rb * 0.23, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = "#fff";
      x.font = `900 ${Rb * 0.32}px ${FONT}`;
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillText(badge.kind === "bang" ? "!" : "?", 0, Rb * 0.02);
    } else {
      x.fillStyle = "#000";
      x.beginPath();
      x.arc(0, 0, Rb * 0.2, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = col;
      x.beginPath();
      x.arc(0, 0, Rb * 0.135, 0, Math.PI * 2);
      x.fill();
    }
    x.restore();
  }

  private drawParticles(x: CanvasRenderingContext2D, R: number, cx: number, cy: number) {
    for (const p of this.particles) {
      if (p.age <= 0) continue;
      const k = p.age / p.life;
      const a = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
      const px = cx + (p.x + p.vx * p.age) * R * 1.3;
      const py = cy + (p.y + p.vy * p.age) * R * 1.3;
      const sz = Math.max(R * p.size * (1 + k * 0.4), 1.4);

      x.save();
      x.translate(px, py);
      x.globalAlpha = Math.min(1, Math.max(0, a));
      switch (p.type) {
        case "heart":
          x.rotate(Math.sin(p.age * 6) * 0.3);
          x.fillStyle = "#FF6F91";
          heartPath(x, sz);
          x.fill();
          break;
        case "star":
          x.rotate(p.rot + p.age * 2);
          x.fillStyle = "#FFD166";
          starPath(x, sz, sz * 0.45);
          x.fill();
          break;
        case "spark":
          x.rotate(p.rot);
          x.fillStyle = "#EFFFE6";
          starPath(x, sz * 0.8, sz * 0.18);
          x.fill();
          break;
        case "sweat":
          x.fillStyle = "#7CC7FF";
          x.beginPath();
          x.moveTo(0, -sz);
          x.quadraticCurveTo(sz * 0.8, sz * 0.2, 0, sz * 0.6);
          x.quadraticCurveTo(-sz * 0.8, sz * 0.2, 0, -sz);
          x.fill();
          break;
        case "z":
          x.fillStyle = "rgb(150,190,138)";
          x.font = `700 ${sz * 1.9}px ${FONT}`;
          x.textAlign = "center";
          x.textBaseline = "middle";
          x.fillText("z", 0, 0);
          break;
      }
      x.restore();
    }
  }
}

