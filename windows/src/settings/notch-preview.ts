// Settings → Notch: a live compact notch at the top of the page. The sides are
// the island's own (island/notch-items.ts: SideView and the item builders, and
// island/notch.css), fed with sample data, so what is drawn here is what the
// notch draws: the same items, their turns and slides at the chosen seconds,
// and the island springing to fit them. Mochi is the hub's live Mochi.
//
// Efficiency, as on the island: one timer, set for the next moment something
// on screen changes, and only while the preview is on screen (in view, the
// window shown and the page visible). The width springs through transforms
// only (two black halves sliding apart), with a CSS transition, no rAF.

import { onEvent } from "../core/bridge";
import { COMPACT_MAX_W, COMPACT_SIDE_MAX, COMPACT_W, compactWidth } from "../core/layout";
import type { Settings } from "../core/state";
import { h } from "../views/dom";
import { t } from "../i18n/i18n";
import { SideView, notchLayout, rotateMsOf, sideItems, type NotchData } from "../island/notch-items";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FOCUS_LENGTH = 25 * MIN;
/** The focus timer's first countdown starts here (18:42). */
const FOCUS_FIRST = 18 * MIN + 42_000;
/** How long the notch takes to spring to its new width. */
const SPRING_MS = 520;

/**
 * Something for every item to show, as of `now`; `start` is when the preview
 * opened (the focus timer counts down from 18:42 from then, and starts again
 * at 25:00 when it runs out).
 */
export function sampleData(now: number, start: number): NotchData {
  const elapsed = Math.max(0, now - start);
  const endsAt = elapsed < FOCUS_FIRST
    ? start + FOCUS_FIRST
    : start + FOCUS_FIRST + (Math.floor((elapsed - FOCUS_FIRST) / FOCUS_LENGTH) + 1) * FOCUS_LENGTH;
  return {
    job: {
      kind: "converting",
      job: { id: 0, names: ["clip.mov"], kind: "video", formats: [] },
      format: { id: "mp4", label: "MP4" },
      index: 0, count: 1, fraction: 0.42,
    },
    focus: { phase: "focus", endsAt, length: FOCUS_LENGTH },
    meeting: { title: t("Standup"), start: now + 12 * MIN - 1, end: now + 42 * MIN, link: null, location: "" },
    media: { title: "Midnight City", artist: "M83", app: "", playing: true, art: null },
    shelfCount: 3,
    glance: { cpu: 12, ramUsed: 7.7, ramTotal: 16, battery: { percent: 81, charging: false }, netDown: 0, netUp: 0 },
    privacy: null,
    download: { item: { path: "", name: "report.pdf", size: 1 }, until: now + DAY },
    devservers: [
      { port: 5173, pid: 1, process: "node", url: "" },
      { port: 8000, pid: 2, process: "python", url: "" },
    ],
    reminders: [{ id: 1, text: t("Essay"), due: now + 2 * DAY + 4 * HOUR + 30 * MIN, fired: false, deadline: true }],
  };
}

/**
 * A spring as a CSS `linear()` easing: settles in its duration with a slight
 * overshoot (damping 0.7), like the island's own spring.
 */
export function springEasing(points = 32): string {
  const zeta = 0.7;
  const omega = 10;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const out: string[] = [];
  for (let i = 0; i <= points; i++) {
    const x = i / points;
    const v = i === points
      ? 1
      : 1 - Math.exp(-zeta * omega * x) * (Math.cos(wd * x) + ((zeta * omega) / wd) * Math.sin(wd * x));
    out.push(v.toFixed(4).replace(/\.?0+$/, "") || "0");
  }
  return `linear(${out.join(", ")})`;
}

const SPRING = springEasing();

function reducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

export class NotchPreview {
  readonly el: HTMLElement;
  private notch: HTMLElement;
  private halves: [HTMLElement, HTMLElement];
  private mochi: HTMLCanvasElement;
  private left = new SideView("left");
  private right = new SideView("right");
  private settings: Settings;
  private readonly start = Date.now();
  private timer: number | null = null;
  private hovered = false;
  private inView = false;
  private windowShown = true;
  /** The width shown, and the sides' widths it was computed from. */
  private width = COMPACT_W;
  private widths = { left: -1, right: -1 };
  private placed = false;
  private mochiAsked = false;
  private disposed = false;
  private cleanup: (() => void)[] = [];

  constructor(settings: Settings) {
    this.settings = settings;
    this.halves = [h("i", { class: "np-half left" }), h("i", { class: "np-half right" })];
    this.mochi = h("canvas", { class: "np-mochi", "aria-hidden": "true" }) as HTMLCanvasElement;
    this.notch = h(
      "div",
      { class: "notch-preview compact", style: `width:${COMPACT_W}px` },
      this.halves[0], this.halves[1], this.left.el, this.right.el, this.mochi,
    );
    this.el = h("div", { class: "np-stage", role: "img", "aria-label": t("Live preview of the notch") },
      this.notch,
      h("div", { class: "np-caption", "aria-hidden": "true", text: t("Live preview with sample data") }),
    );
    this.el.style.setProperty?.("--np-spring", SPRING);
    this.setHalves(COMPACT_W);

    // As on the island, the turn waits while the pointer is over the notch.
    this.notch.addEventListener("pointerenter", () => {
      this.hovered = true;
      this.render();
    });
    this.notch.addEventListener("pointerleave", () => {
      this.hovered = false;
      const now = Date.now();
      this.left.restartTurn(now, rotateMsOf(this.settings.leftRotateSeconds));
      this.right.restartTurn(now, rotateMsOf(this.settings.rotateSeconds));
      this.render();
    });

    if (typeof IntersectionObserver === "function") {
      const io = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        // Gone from the page (another page is shown): stop for good. Before
        // it is first put in the page there is nothing to do yet.
        if (!this.el.isConnected) {
          if (this.placed) this.dispose();
          return;
        }
        this.inView = entry.isIntersecting;
        this.wake();
      });
      io.observe(this.el);
      this.cleanup.push(() => io.disconnect());
    } else {
      this.inView = true;
    }
    if (typeof document.addEventListener === "function") {
      const onVisibility = () => this.wake();
      document.addEventListener("visibilitychange", onVisibility);
      this.cleanup.push(() => document.removeEventListener("visibilitychange", onVisibility));
    }
    void onEvent<boolean>("hub-visible", (shown) => {
      this.windowShown = shown;
      this.wake();
    }).then((off) => {
      if (this.disposed) off?.();
      else this.cleanup.push(() => off?.());
    });
    // The text's width is known once the font is in.
    void (document as Document & { fonts?: FontFaceSet }).fonts?.ready.then(() => this.remeasure());
  }

  /** The settings changed: the preview follows at once. */
  update(settings: Settings) {
    this.settings = settings;
    this.render();
  }

  /** On screen: worth drawing and ticking. */
  private active(): boolean {
    return !this.disposed && this.el.isConnected === true && this.inView && this.windowShown
      && (document.visibilityState ?? "visible") !== "hidden";
  }

  private wake() {
    if (!this.active()) {
      this.stopTimer();
      return;
    }
    if (!this.mochiAsked) {
      this.mochiAsked = true;
      // Loaded only in the window: the hub's animation loop draws him while it is on screen.
      import("../hub/hero").then(
        ({ liveMochi }) => {
          if (this.disposed) return;
          const engine = liveMochi(this.mochi);
          // Room above him for the particles, as on the island (island.ts BOT_OVERHANG).
          engine.particleOverhang = 40;
        },
        () => {},
      );
    }
    this.render();
  }

  private dispose() {
    this.disposed = true;
    this.stopTimer();
    for (const fn of this.cleanup.splice(0)) fn();
  }

  private stopTimer() {
    if (this.timer != null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private render() {
    if (this.disposed) return;
    const now = Date.now();
    const s = this.settings;
    const off = s.disabledFeatures ?? [];
    const lists = notchLayout(s);
    const data = sampleData(now, this.start);
    let changed = this.left.update(sideItems(lists.left, off, data, now), now, this.hovered, rotateMsOf(s.leftRotateSeconds));
    if (this.right.update(sideItems(lists.right, off, data, now), now, this.hovered, rotateMsOf(s.rotateSeconds))) changed = true;
    if (changed) this.measure();
    this.schedule(now);
  }

  private remeasure() {
    this.widths = { left: -1, right: -1 };
    this.measure();
  }

  /** The sides' widths, once per change of what they show; the notch springs to fit. */
  private measure() {
    if (this.el.isConnected !== true) return;
    const left = Math.min(COMPACT_SIDE_MAX, Number(this.left.width()) || 0);
    const right = Math.min(COMPACT_SIDE_MAX, Number(this.right.width()) || 0);
    if (Math.abs(left - this.widths.left) < 2 && Math.abs(right - this.widths.right) < 2) return;
    this.widths = { left, right };
    const w = compactWidth(left, right);
    if (w === this.width && this.placed) return;
    this.setWidth(w, this.placed && !reducedMotion());
    this.placed = true;
  }

  /**
   * Lays the notch out at `w` and, when animating, springs it there: the black
   * halves slide (CSS transition) and the sides glide from where they were
   * (FLIP), transforms only.
   */
  private setWidth(w: number, animate: boolean) {
    const sides = [this.left.el, this.right.el];
    const before = animate ? sides.map((el) => el.getBoundingClientRect().left) : [];
    this.width = w;
    this.notch.style.width = `${w}px`;
    this.notch.classList.toggle("np-still", !animate);
    this.setHalves(w);
    if (!animate) return;
    // The page may show the notch scaled down (narrow window): undo it for the offsets.
    const scale = this.notch.getBoundingClientRect().width / (this.notch.offsetWidth || w) || 1;
    sides.forEach((el, i) => {
      const dx = (before[i] - el.getBoundingClientRect().left) / scale;
      if (Math.abs(dx) < 0.5 || typeof el.animate !== "function") return;
      for (const a of el.getAnimations?.() ?? []) a.cancel();
      try {
        el.animate([{ transform: `translateX(${dx}px)` }, { transform: "translateX(0)" }], { duration: SPRING_MS, easing: SPRING });
      } catch {
        el.animate([{ transform: `translateX(${dx}px)` }, { transform: "translateX(0)" }], { duration: 360, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
      }
    });
  }

  /** Each black half reaches from the middle to one edge of a `w`-wide notch. */
  private setHalves(w: number) {
    const d = (COMPACT_MAX_W - w) / 2;
    this.halves[0].style.transform = `translateX(${d}px)`;
    this.halves[1].style.transform = `translateX(${-d}px)`;
  }

  /** The one timer: the next moment something on screen changes by itself. */
  private schedule(now: number) {
    this.stopTimer();
    if (!this.active()) return;
    const waits = [...this.left.waits(now, this.hovered), ...this.right.waits(now, this.hovered)];
    if (waits.length === 0) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.render();
    }, Math.min(...waits, DAY) + 15);
  }

  /** Test hook: the width the notch is laid out at. */
  get shownWidth(): number {
    return this.width;
  }
}
