// Dev harness: Stew in every state, emote and accessory, at the sizes the app
// draws him (13, 16, 20, 40 and 120 px slots), on dark and light, plus the
// greeting frame by frame. Open /dev/stew-sheet.html (add ?guide for the
// slot outlines). Not part of the app bundle.

import { BotEngine } from "../src/mochi/engine";
import { Greeting, GREETING_H, GREETING_W } from "../src/mochi/greeting";
import { OUTFIT_SELECTIONS, type Outfit } from "../src/mochi/wardrobe";
import type { BotEmoteName, BotStateName } from "../src/core/layout";

const params = new URLSearchParams(location.search);
const GUIDE = params.has("guide");
const SIZES = (params.get("sizes") ?? "13,16,20,40,120").split(",").map(Number);
const only = params.get("only");
// ?zoom=4 magnifies the page (the canvases keep their real pixels) for close looks.
if (params.has("zoom")) (document.body.style as CSSStyleDeclaration & { zoom: string }).zoom = params.get("zoom")!;

const STATES: BotStateName[] = [
  "idle", "working", "thinking", "searching", "approval", "question",
  "error", "finished", "ratelimit", "sleeping", "dizzy",
];
const EMOTES: BotEmoteName[] = ["love", "surprised", "proud", "wink", "yawn", "happy", "annoyed"];
const OUTFITS = OUTFIT_SELECTIONS.filter((s) => s !== "auto" && s !== "none") as Outfit[];

interface Live { canvas: HTMLCanvasElement; engine: BotEngine; d: number; side: number; over: number; setup: (e: BotEngine) => void; again: number }
const lives: Live[] = [];

function cell(parent: HTMLElement, cls: string, d: number, label: string, setup: (e: BotEngine) => void, again = 0) {
  const side = Math.max(6, d * 0.5);
  const over = Math.max(12, d * 0.8);
  const w = d / 0.6;
  const div = document.createElement("div");
  div.className = `cell ${cls}`;
  const canvas = document.createElement("canvas");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round((w + side * 2) * dpr);
  canvas.height = Math.round((w + over) * dpr);
  canvas.style.width = `${w + side * 2}px`;
  canvas.style.height = `${w + over}px`;
  div.append(canvas);
  const l = document.createElement("div");
  l.className = "label";
  l.textContent = label;
  div.append(l);
  parent.append(div);
  const engine = new BotEngine();
  engine.particleOverhang = over;
  setup(engine);
  lives.push({ canvas, engine, d, side, over, setup, again });
}

function section(title: string, rows: { label: string; setup: (e: BotEngine) => void; again?: number }[]) {
  if (only && !title.toLowerCase().includes(only)) return;
  const root = document.getElementById("root")!;
  const h = document.createElement("h2");
  h.textContent = title;
  root.append(h);
  const grid = document.createElement("div");
  grid.className = "grid";
  grid.style.gridTemplateColumns = `repeat(${SIZES.length * 2}, auto)`;
  root.append(grid);
  for (const row of rows) {
    for (const bg of ["dark", "light"]) {
      for (const d of SIZES) cell(grid, bg, d, `${row.label} ${d}`, row.setup, row.again ?? 0);
    }
  }
}

section("States", STATES.map((s) => ({ label: s, setup: (e) => e.setState(s, true) })));
section("Emotes", EMOTES.map((m) => ({ label: m, setup: (e) => e.triggerEmote(m, 9999), again: m === "yawn" ? 3 : 0 })));
section("Accessories", OUTFITS.map((o) => ({ label: o, setup: (e) => e.setOutfit(o, false) })));
section("Poses", [
  { label: "catch", setup: (e) => { e.morph = 1; e.slotH = 0.2; e.slotHTarget = 0.2; } },
  { label: "update", setup: (e) => { e.setUpdateHint([0.231, 0.51, 0.965]); e.bodyColor = [0.231, 0.51, 0.965]; } },
  { label: "look-l", setup: (e) => { e.lookX = -1; e.lookY = 0.3; } },
  { label: "look-r", setup: (e) => { e.lookX = 1; e.lookY = -0.6; } },
  { label: "slap", setup: (e) => e.slap(), again: 1.5 },
  { label: "greet", setup: (e) => e.greet(), again: 2 },
  { label: "dance", setup: (e) => e.setDancing(true) },
  { label: "desk", setup: (e) => { e.groundShadow = true; e.ambient = true; } },
]);

// The greeting, frame by frame.
const greetTimes = (params.get("gt") ?? "0.35,0.56,0.8,1.25,1.5,1.8,2.2,2.7,3.1,3.5,4.5").split(",").map(Number);
const greetCanvases: { c: HTMLCanvasElement; g: Greeting; t: number }[] = [];
if (!only || "greeting".includes(only)) {
  const root = document.getElementById("root")!;
  const h = document.createElement("h2");
  h.textContent = "Greeting";
  root.append(h);
  for (const t of greetTimes) {
    const c = document.createElement("canvas");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = GREETING_W * dpr;
    c.height = GREETING_H * dpr;
    c.style.width = `${GREETING_W / 2}px`;
    c.style.height = `${GREETING_H / 2}px`;
    c.style.margin = "4px 12px";
    c.style.background = "#000";
    c.title = `t=${t}`;
    const wrap = document.createElement("div");
    wrap.style.display = "inline-block";
    wrap.append(c);
    const l = document.createElement("div");
    l.className = "label";
    l.style.marginLeft = "12px";
    l.textContent = `t = ${t}s`;
    wrap.append(l);
    root.append(wrap);
    const g = new Greeting();
    greetCanvases.push({ c, g, t });
  }
}

let last = performance.now();
const born = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  for (const l of lives) {
    if (l.again > 0 && (now - born) / 1000 > l.again) {
      l.again = l.again + 2.5;
      l.setup(l.engine);
    }
    const ctx = l.canvas.getContext("2d")!;
    const dpr = l.canvas.width / parseFloat(l.canvas.style.width);
    const w = l.d / 0.6;
    l.engine.update(dt);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, l.side * dpr, 0);
    if (GUIDE) {
      ctx.strokeStyle = "rgba(255,0,0,0.5)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(w / 2, l.over + w / 2, l.d / 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.save();
    l.engine.applyDance(ctx, w, w + l.over);
    l.engine.draw(ctx, w, w + l.over);
    ctx.restore();
  }
  for (const { c, g, t } of greetCanvases) {
    const ctx = c.getContext("2d")!;
    const dpr = c.width / GREETING_W;
    // Hold the greeting at `t`.
    (g as unknown as { startMs: number }).startMs = now - t * 1000;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.draw(ctx);
  }
}
// A timer rather than rAF: a hidden preview pane gets no animation frames.
setInterval(() => frame(performance.now()), 33);
