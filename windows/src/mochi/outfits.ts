// Stew's accessories, drawn in code in the ball space of stew.ts (origin at
// his centre, y down, `g.r` his radius). drawStew hands over where his face
// is, already turned by his tilt and roll, so each accessory follows his look
// and rolls with him while the light stays put. Below stew.SMALL_R only the
// bold shapes are drawn.

import { SCRIPT_FONTS } from "../core/fonts";
import { drawStew, restPose, type StewGeom } from "./stew";
import type { Outfit, OutfitSelection } from "./wardrobe";

type Ctx = CanvasRenderingContext2D;

export interface OutfitState {
  /** 0 = gone, 1 = fully on. */
  presence: number;
  /** Swing of the soft parts (scarf end, pompom), −1…1. */
  swing: number;
}

/** Hats sit on top and drop in from above. */
const HATS: ReadonlySet<Outfit> = new Set(["beanie", "crown", "partyHat", "headphones"]);

function rr(x: Ctx, X: number, Y: number, W: number, H: number, R: number) {
  const r = Math.max(0, Math.min(R, W / 2, H / 2));
  x.beginPath();
  x.moveTo(X + r, Y);
  x.arcTo(X + W, Y, X + W, Y + H, r);
  x.arcTo(X + W, Y + H, X, Y + H, r);
  x.arcTo(X, Y + H, X, Y, r);
  x.arcTo(X, Y, X + W, Y, r);
  x.closePath();
}

const lw = (g: StewGeom, k: number, min = 1) => Math.max(g.r * k, min);
/** How far a hat follows his look sideways. */
const hatX = (g: StewGeom) => g.faceX * 0.45;

// ── Beanie: a knit cap with a pompom ─────────────────────────────────────────

function beanie(x: Ctx, g: StewGeom, swing: number) {
  const r = g.r;
  const edge = g.faceY - g.eyeH * 0.75; // just above the eyes
  const outer = new Path2D();
  outer.arc(0, 0, r * 1.05, 0, Math.PI * 2);
  x.save();
  x.clip(outer);
  const cap = x.createLinearGradient(-r, -r, r * 0.6, edge);
  cap.addColorStop(0, "#F59A62");
  cap.addColorStop(1, "#D2582A");
  x.fillStyle = cap;
  x.fillRect(-r * 1.2, -r * 1.2, r * 2.4, edge - r * 0.16 + r * 1.2);
  if (!g.small) {
    x.strokeStyle = "rgba(110,36,10,0.25)";
    x.lineWidth = lw(g, 0.035, 0.6);
    for (let i = -3; i <= 3; i++) {
      const bx = i * r * 0.27 + hatX(g);
      x.beginPath();
      x.moveTo(bx, edge - r * 0.16);
      x.quadraticCurveTo(bx * 0.8, -r * 0.7, bx * 0.4, -r * 1.05);
      x.stroke();
    }
  }
  // Folded cuff
  x.fillStyle = "#F4B072";
  x.fillRect(-r * 1.2, edge - r * 0.24, r * 2.4, r * 0.24);
  if (!g.small) {
    x.fillStyle = "rgba(110,36,10,0.2)";
    x.fillRect(-r * 1.2, edge - r * 0.04, r * 2.4, r * 0.04);
  }
  x.restore();
  // Pompom, swinging a little behind his moves.
  const pr = Math.max(r * 0.2, 1.6);
  const px = hatX(g) + swing * r * 0.12;
  const py = -r * 1.02 - pr * 0.6;
  x.fillStyle = "#FBE3C8";
  x.beginPath();
  x.arc(px, py, pr, 0, Math.PI * 2);
  x.fill();
  if (!g.small) {
    x.fillStyle = "rgba(160,90,40,0.25)";
    x.beginPath();
    x.arc(px + pr * 0.25, py + pr * 0.25, pr * 0.7, 0, Math.PI * 2);
    x.fill();
  }
}

// ── Glasses ──────────────────────────────────────────────────────────────────

function roundGlasses(x: Ctx, g: StewGeom) {
  const rad = Math.max(g.eyeH * 0.78, g.eyeW * 1.15);
  x.strokeStyle = "#3B2A1A";
  x.lineWidth = lw(g, 0.05, 0.9);
  for (const [ex, fx] of [[g.eyeL, g.fxL], [g.eyeR, g.fxR]] as const) {
    if (fx < 0.08) continue;
    x.fillStyle = "rgba(220,240,255,0.16)";
    x.beginPath();
    x.ellipse(ex, g.eyeY, rad * fx, rad * g.fy, 0, 0, Math.PI * 2);
    x.fill();
    x.stroke();
  }
  if (g.fxL > 0.08 && g.fxR > 0.08) {
    x.beginPath();
    x.moveTo(g.eyeL + rad * g.fxL, g.eyeY - rad * 0.15);
    x.quadraticCurveTo(g.faceX, g.eyeY - rad * 0.55, g.eyeR - rad * g.fxR, g.eyeY - rad * 0.15);
    x.stroke();
  }
}

function sunglasses(x: Ctx, g: StewGeom) {
  const w = Math.max(g.eyeW * 2.3, g.r * 0.46);
  const h = Math.max(g.eyeH * 1.15, g.r * 0.34);
  x.fillStyle = "#17191C";
  for (const [ex, fx] of [[g.eyeL, g.fxL], [g.eyeR, g.fxR]] as const) {
    if (fx < 0.08) continue;
    const ww = w * fx;
    rr(x, ex - ww / 2, g.eyeY - h * 0.5, ww, h, Math.min(h * 0.45, ww / 2));
    x.fill();
    if (!g.small) {
      x.fillStyle = "rgba(255,255,255,0.3)";
      x.beginPath();
      x.ellipse(ex - ww * 0.18, g.eyeY - h * 0.18, ww * 0.16, h * 0.1, -0.5, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = "#17191C";
    }
  }
  if (g.fxL > 0.08 && g.fxR > 0.08) {
    x.strokeStyle = "#17191C";
    x.lineWidth = lw(g, 0.05, 0.9);
    x.beginPath();
    x.moveTo(g.eyeL + (w * g.fxL) / 2 - 0.5, g.eyeY - h * 0.2);
    x.lineTo(g.eyeR - (w * g.fxR) / 2 + 0.5, g.eyeY - h * 0.2);
    x.stroke();
  }
}

// ── Scarf: wrapped round his lower half, one end swinging ───────────────────

function scarf(x: Ctx, g: StewGeom, swing: number) {
  const r = g.r;
  const top = r * 0.4;
  const band = r * 0.26;
  const outer = new Path2D();
  outer.arc(0, 0, r * 1.05, 0, Math.PI * 2);
  // The hanging end, on his left.
  x.save();
  x.translate(r * 0.42, top + band * 0.6);
  x.rotate(0.12 + swing * 0.35);
  x.fillStyle = "#B83A3A";
  rr(x, -r * 0.11, 0, r * 0.22, r * 0.48, r * 0.06);
  x.fill();
  if (!g.small) {
    x.fillStyle = "#F6E7C8";
    x.fillRect(-r * 0.11, r * 0.3, r * 0.22, r * 0.06);
  }
  x.restore();
  x.save();
  x.clip(outer);
  const sg = x.createLinearGradient(-r, 0, r, 0);
  sg.addColorStop(0, "#E05A50");
  sg.addColorStop(1, "#B63838");
  x.fillStyle = sg;
  x.beginPath();
  x.moveTo(-r * 1.2, top + r * 0.06);
  x.quadraticCurveTo(0, top - r * 0.06, r * 1.2, top + r * 0.06);
  x.lineTo(r * 1.2, top + band + r * 0.06);
  x.quadraticCurveTo(0, top + band - r * 0.04, -r * 1.2, top + band + r * 0.06);
  x.closePath();
  x.fill();
  if (!g.small) {
    x.strokeStyle = "#F6E7C8";
    x.lineWidth = lw(g, 0.045, 0.7);
    for (let i = -2; i <= 2; i++) {
      const sx = i * r * 0.36 + g.faceX * 0.3;
      x.beginPath();
      x.moveTo(sx - r * 0.04, top + r * 0.02);
      x.lineTo(sx + r * 0.04, top + band);
      x.stroke();
    }
  }
  x.restore();
}

// ── Headphones: band over the top, cups on the sides ─────────────────────────

function headphones(x: Ctx, g: StewGeom) {
  const r = g.r;
  const cx0 = hatX(g) * 0.5;
  const cy = g.faceY * 0.5;
  // Light grey with a darker edge: they read on the black island and on light pages.
  x.lineCap = "round";
  x.strokeStyle = "#3A4250";
  x.lineWidth = lw(g, 0.14, 1.8);
  x.beginPath();
  x.arc(cx0, cy, r * 1.08, Math.PI * 1.1, Math.PI * 1.9);
  x.stroke();
  x.strokeStyle = "#D5DCE5";
  x.lineWidth = lw(g, 0.08, 1);
  x.stroke();
  for (const sd of [-1, 1]) {
    const cx = cx0 + sd * r * 1.0;
    const w = Math.max(r * 0.28, 2.2);
    const h = Math.max(r * 0.52, 3.6);
    x.fillStyle = "#D5DCE5";
    rr(x, cx - w / 2, cy - h / 2, w, h, w * 0.45);
    x.fill();
    x.strokeStyle = "#3A4250";
    x.lineWidth = lw(g, 0.035, 0.7);
    x.stroke();
    if (!g.small) {
      x.fillStyle = "#5BC0EB";
      rr(x, cx - w * 0.22 + sd * w * 0.12, cy - h * 0.3, w * 0.44, h * 0.6, w * 0.2);
      x.fill();
    }
  }
}

// ── Crown: small, gold, worn at a jaunty angle ───────────────────────────────

function crown(x: Ctx, g: StewGeom) {
  const r = g.r;
  x.save();
  x.translate(hatX(g) - r * 0.12, -r * 0.88);
  x.rotate(-0.2);
  const w = Math.max(r * 0.84, 4.6);
  const h = Math.max(r * 0.5, 3);
  const cg = x.createLinearGradient(-w / 2, -h, w / 2, 0);
  cg.addColorStop(0, "#FFE07A");
  cg.addColorStop(1, "#E3A51F");
  x.fillStyle = cg;
  x.beginPath();
  x.moveTo(-w / 2, 0);
  x.lineTo(-w / 2, -h * 0.85);
  x.lineTo(-w / 4, -h * 0.4);
  x.lineTo(0, -h);
  x.lineTo(w / 4, -h * 0.4);
  x.lineTo(w / 2, -h * 0.85);
  x.lineTo(w / 2, 0);
  x.closePath();
  x.fill();
  x.fillStyle = "#C98A12";
  x.fillRect(-w / 2, -h * 0.18, w, h * 0.18);
  if (!g.small) {
    x.fillStyle = "#E5484D";
    x.beginPath();
    x.arc(0, -h * 0.42, w * 0.08, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = "#FFF4C2";
    for (const px of [-w / 2, 0, w / 2]) {
      x.beginPath();
      x.arc(px, px === 0 ? -h : -h * 0.85, w * 0.055, 0, Math.PI * 2);
      x.fill();
    }
  }
  x.restore();
}

// ── Party hat: a striped cone, tipped to one side ────────────────────────────

function partyHat(x: Ctx, g: StewGeom) {
  const r = g.r;
  x.save();
  x.translate(hatX(g) - r * 0.18, -r * 0.9);
  x.rotate(-0.28);
  const w = Math.max(r * 0.6, 4.2);
  const h = Math.max(r * 0.82, 5.4);
  x.beginPath();
  x.moveTo(-w / 2, 0);
  x.lineTo(0, -h);
  x.lineTo(w / 2, 0);
  x.quadraticCurveTo(0, w * 0.18, -w / 2, 0);
  x.closePath();
  x.fillStyle = "#7B6CF6";
  x.fill();
  if (!g.small) {
    x.save();
    x.clip();
    x.strokeStyle = "#FFD166";
    x.lineWidth = r * 0.08;
    for (const k of [0.3, 0.62]) {
      x.beginPath();
      x.moveTo(-w, -h * k + w * 0.3);
      x.lineTo(w, -h * k - w * 0.3);
      x.stroke();
    }
    x.restore();
  }
  x.fillStyle = "#FF6F91";
  x.beginPath();
  x.arc(0, -h, Math.max(r * 0.1, 1.1), 0, Math.PI * 2);
  x.fill();
  x.restore();
}

// ── Flower: a little daisy tucked on the side of his head ────────────────────

function flower(x: Ctx, g: StewGeom) {
  const r = g.r;
  const s = Math.max(r * 0.2, 1.9);
  x.save();
  x.translate(r * 0.6 + g.faceX * 0.25, -r * 0.62);
  x.fillStyle = "#FFFFFF";
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    x.beginPath();
    x.ellipse(Math.cos(a) * s * 0.75, Math.sin(a) * s * 0.75, s * 0.55, s * 0.36, a, 0, Math.PI * 2);
    x.fill();
  }
  x.fillStyle = "#FFC93C";
  x.beginPath();
  x.arc(0, 0, s * 0.45, 0, Math.PI * 2);
  x.fill();
  x.restore();
}

// ── Layers ────────────────────────────────────────────────────────────────────

/** Drawn over his face. */
export function drawOutfitFront(x: Ctx, outfit: Outfit, g: StewGeom, st: OutfitState) {
  if (outfit === "none") return;
  const p = Math.max(0, Math.min(1, st.presence));
  if (p <= 0.01) return;
  x.save();
  x.globalAlpha *= Math.min(1, p * 1.6);
  // Hats drop in from above; the rest just appears.
  if (HATS.has(outfit)) x.translate(0, -(1 - p) * g.r * 0.5);
  switch (outfit) {
    case "beanie": beanie(x, g, st.swing); break;
    case "roundGlasses": roundGlasses(x, g); break;
    case "sunglasses": sunglasses(x, g); break;
    case "scarf": scarf(x, g, st.swing); break;
    case "headphones": headphones(x, g); break;
    case "crown": crown(x, g); break;
    case "flower": flower(x, g); break;
    case "partyHat": partyHat(x, g); break;
  }
  x.restore();
}

// ── Wardrobe icons ────────────────────────────────────────────────────────────

/** A little Stew wearing `outfit`, centred in a `size`×`size` icon. */
function iconStew(x: Ctx, size: number, outfit: Outfit) {
  const r = size * 0.3;
  const st: OutfitState = { presence: 1, swing: 0 };
  x.save();
  // Hats add height on top: he sits a little low then.
  x.translate(size / 2, size / 2 + (outfit === "beanie" || outfit === "partyHat" || outfit === "crown" ? r * 0.22 : 0));
  drawStew(x, restPose(r), { front: (c, g) => drawOutfitFront(c, outfit, g, st) });
  x.restore();
}

/**
 * One wardrobe button's picture. "auto" shows the season's accessory with an
 * AUTO tag, "none" a crossed-out circle.
 */
export function drawWardrobeIcon(x: Ctx, size: number, selection: OutfitSelection, seasonal: Outfit, autoLabel: string) {
  x.clearRect(0, 0, size, size);
  if (selection === "none") {
    const r = 6.5;
    x.save();
    x.translate(size / 2, size / 2);
    x.strokeStyle = "#454850";
    x.lineWidth = 1.4;
    x.lineCap = "round";
    x.beginPath();
    x.arc(0, 0, r * 0.82, 0, Math.PI * 2);
    x.moveTo(-r * 0.56, r * 0.56);
    x.lineTo(r * 0.56, -r * 0.56);
    x.stroke();
    x.restore();
    return;
  }
  iconStew(x, size, selection === "auto" ? seasonal : selection);
  if (selection !== "auto") return;
  const by = size - 4;
  const bw = 14;
  const bh = 6.5;
  x.save();
  x.translate(size / 2, by);
  rr(x, -bw / 2, -bh / 2, bw, bh, bh / 2);
  x.fillStyle = "rgba(0,0,0,0.6)";
  x.fill();
  x.fillStyle = "#FFFFFF";
  // A longer translation of "AUTO" gets a smaller font rather than overflowing the badge.
  let fontPx = 4.2;
  x.font = `600 ${fontPx}px system-ui, "Segoe UI", ${SCRIPT_FONTS}, sans-serif`;
  while (x.measureText(autoLabel).width > bw - 2 && fontPx > 2.6) {
    fontPx -= 0.2;
    x.font = `600 ${fontPx}px system-ui, "Segoe UI", ${SCRIPT_FONTS}, sans-serif`;
  }
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(autoLabel, 0, 0.2);
  x.restore();
}
