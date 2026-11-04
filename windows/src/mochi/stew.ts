// Stew, Pod's own character: a glossy green ball, drawn in code as a lit sphere.
//
// One drawing shared by the live engine (engine.ts), the launch greeting
// (greeting.ts) and the wardrobe icons (outfits.ts). Everything is in the
// ball's own space: origin at his centre, y down, `r` his radius.
//
// How the 3D look is built (large sizes):
//   1. Diffuse: a radial gradient centred toward the light (upper left), from a
//      warm, slightly yellow-green lit side (#B5E79A) through the base
//      (#7CC46A) to the shadow side (#3F8A3A).
//   2. Terminator and rim: a second radial gradient, centred a little toward
//      the light, darkens the last fifth of the radius, most at the lower right.
//   3. Subsurface warmth: a faint yellow-green glow just inside the lit side.
//   4. Bounce light: a soft lighter band along the lower-right edge, light
//      thrown back from the surface he sits on.
//   5. Ambient occlusion: the bottom darkens where he meets a surface.
//   6. Gloss: a broad, soft sheen plus a small crisp specular highlight.
// The light never moves: rolls and tilts turn only his face (and accessories)
// around his centre. His eyes, mouth and cheeks are points on the sphere —
// longitude and latitude, projected — so they shift and narrow
// (foreshortening) as they near the edge.
// Small sizes (13–20 px) keep one gradient, one highlight and the eyes, with a
// floor on the eye size so they still read.

export type RGB = readonly [number, number, number]; // components 0…1

/** Palette: base, light side, shadow side, eyes. */
export const BALL_BASE: RGB = hex("#7CC46A");
export const BALL_LIGHT: RGB = hex("#B5E79A");
export const BALL_SHADOW: RGB = hex("#3F8A3A");
export const EYE_INK = "#1F2A1C";
export const HEART = "#FF6F91";

export type StewEye =
  | "oval" | "wide" | "dot" | "annoyed" | "flat" | "happy" | "closed"
  | "dizzy" | "sparkle" | "tired" | "wink" | "love";

export interface StewPose {
  r: number;
  /** Squash and stretch about his bottom (the light stays put; only the shape changes). */
  sx: number;
  sy: number;
  /** Turn the face around the view axis, like rolling sideways (radians). */
  tilt: number;
  roll: number;
  /** Where the face points, −1…1 (y up): the features slide over the sphere. */
  lookX: number;
  lookY: number;
  eye: StewEye;
  /** Eyelids: 1 open, 0 shut. */
  open: number;
  /** Eye scale (hover widens them a little). */
  es: number;
  /** The little "o", 0…1+. */
  mouth: number;
  blush: number;
  /** Body colour; null = Stew green. */
  color: RGB | null;
  /** State colour washing up from below, and how much. */
  wash: RGB | null;
  washA: number;
  /** 0…1: sitting on a surface (ambient occlusion at the bottom). */
  ground: number;
  /** Seconds, for the details that move by themselves (dizzy eyes, sparkles). */
  t: number;
}

/** Where the face is, for the accessories (in the face's turned frame). */
export interface StewGeom {
  r: number;
  /** Face centre (between the eyes). */
  faceX: number;
  faceY: number;
  /** Eye centres, their size, and their foreshortening (1 = seen face on). */
  eyeL: number;
  eyeR: number;
  eyeY: number;
  eyeW: number;
  eyeH: number;
  fxL: number;
  fxR: number;
  fy: number;
  /** Below SMALL_R only the bold shapes are drawn. */
  small: boolean;
}

export interface StewLayers {
  /** Drawn over the face and its gloss (hats, glasses, scarf, flower). */
  front?: (x: CanvasRenderingContext2D, g: StewGeom) => void;
}

export const SMALL_R = 9;

/**
 * In a slot of diameter d (the layouts' botDiameter), his diameter is
 * d × PEA_SCALE and his centre sits d/2 × PEA_DROP below the slot's centre.
 */
export const PEA_SCALE = 0.9;
export const PEA_DROP = 0;

export function hex(h: string): RGB {
  const v = parseInt(h.replace("#", ""), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export const rgba = (c: RGB, a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

export const mixRGB = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
];

const WHITE: RGB = [1, 1, 1];
const BLACK: RGB = [0, 0, 0];
const WARM: RGB = hex("#E9FF9E");

/** Light side, base, shadow side of the body. */
export function palette(color: RGB | null): [RGB, RGB, RGB] {
  if (!color) return [BALL_LIGHT, BALL_BASE, BALL_SHADOW];
  return [mixRGB(color, WHITE, 0.42), color, mixRGB(color, BLACK, 0.4)];
}

export function restPose(r: number): StewPose {
  return {
    r, sx: 1, sy: 1, tilt: 0, roll: 0, lookX: 0, lookY: 0,
    eye: "oval", open: 1, es: 1, mouth: 0, blush: 0,
    color: null, wash: null, washA: 0, ground: 0, t: 0,
  };
}

// ── The sphere's surface ──────────────────────────────────────────────────────

/** Face direction: longitude and latitude (radians) of the point between his eyes. */
function faceDir(p: StewPose) {
  return { lon: p.lookX * 0.55, lat: 0.06 + p.lookY * 0.4 };
}

/** A point on the sphere at (lon, lat) → screen offset, foreshortening, facing. */
function onSphere(r: number, lon: number, lat: number) {
  const cl = Math.cos(lat);
  return {
    x: r * Math.sin(lon) * cl,
    y: -r * Math.sin(lat),
    fx: Math.cos(lon),
    fy: cl,
    facing: Math.cos(lon) * cl,
  };
}

/** Eye size and spacing, with a floor so two eyes still read at 13 px. */
function eyeMetrics(r: number, es: number) {
  const w = Math.max(r * 0.21, 1.5) * es;
  const h = Math.max(r * 0.3, 2.1) * es;
  // Spacing as an angle: wider apart on tiny balls so the eyes don't merge.
  const lon = r < SMALL_R ? Math.min(0.62, Math.asin(Math.min(0.9, Math.max(r * 0.33, 2.2) / r))) : 0.34;
  return { w, h, lon };
}

export function geometry(p: StewPose): StewGeom {
  const r = p.r;
  const { w, h, lon } = eyeMetrics(r, p.es);
  const f = faceDir(p);
  const c = onSphere(r, f.lon, f.lat);
  const L = onSphere(r, f.lon - lon, f.lat);
  const R = onSphere(r, f.lon + lon, f.lat);
  return {
    r, faceX: c.x, faceY: c.y,
    eyeL: L.x, eyeR: R.x, eyeY: c.y, eyeW: w, eyeH: h,
    fxL: Math.max(0, L.fx), fxR: Math.max(0, R.fx), fy: c.fy,
    small: r < SMALL_R,
  };
}

// ── Drawing ───────────────────────────────────────────────────────────────────

/** Draws Stew with his centre at the current origin. */
export function drawStew(x: CanvasRenderingContext2D, p: StewPose, layers: StewLayers = {}) {
  const r = p.r;
  if (r <= 0.3) return;
  const small = r < SMALL_R;

  x.save();
  // Squash about his bottom, so a landing flattens him onto the ground.
  x.translate(0, r);
  x.scale(p.sx, p.sy);
  x.translate(0, -r);

  const body = new Path2D();
  body.arc(0, 0, r, 0, Math.PI * 2);
  drawBody(x, body, p, small);

  const turn = p.tilt + p.roll;
  const g = geometry(p);
  x.save();
  x.clip(body);
  // The face turns with tilt and roll; the light above does not.
  if (turn) x.rotate(turn);
  if (p.blush > 0.01) drawBlush(x, p, g);
  drawEyes(x, p, g);
  if (p.mouth > 0.04) drawMouth(x, p);
  x.restore();

  // Gloss on the ball's surface, over his face; accessories sit on top of it.
  drawGloss(x, r, small);
  if (layers.front) {
    x.save();
    if (turn) x.rotate(turn);
    layers.front(x, g);
    x.restore();
  }
  x.restore();
}

function drawBody(x: CanvasRenderingContext2D, body: Path2D, p: StewPose, small: boolean) {
  const r = p.r;
  const [light, base, shadow] = palette(p.color);

  // 1. Diffuse shading, lit from the upper left.
  const d = x.createRadialGradient(-r * 0.4, -r * 0.45, r * 0.05, -r * 0.18, -r * 0.2, r * 1.38);
  d.addColorStop(0, rgba(light));
  d.addColorStop(small ? 0.42 : 0.34, rgba(base));
  d.addColorStop(small ? 0.92 : 0.8, rgba(mixRGB(base, shadow, 0.75)));
  d.addColorStop(1, rgba(shadow));
  x.fillStyle = d;
  x.fill(body);

  if (p.wash && p.washA > 0.01) {
    const w = x.createLinearGradient(0, r, 0, -r * 0.25);
    w.addColorStop(0, rgba(p.wash, 0.6 * p.washA));
    w.addColorStop(1, rgba(p.wash, 0));
    x.fillStyle = w;
    x.fill(body);
  }
  if (small) return;

  x.save();
  x.clip(body);

  // 2. Terminator and rim: the edge rolls into shadow, most at the lower right.
  const t = x.createRadialGradient(-r * 0.22, -r * 0.26, r * 0.55, -r * 0.08, -r * 0.1, r * 1.2);
  t.addColorStop(0, "rgba(16,48,14,0)");
  t.addColorStop(0.72, "rgba(16,48,14,0)");
  t.addColorStop(1, "rgba(16,48,14,0.42)");
  x.fillStyle = t;
  x.fillRect(-r, -r, r * 2, r * 2);

  // 3. Subsurface warmth near the light.
  const s = x.createRadialGradient(-r * 0.3, -r * 0.34, 0, -r * 0.3, -r * 0.34, r * 0.75);
  s.addColorStop(0, rgba(WARM, 0.28));
  s.addColorStop(1, rgba(WARM, 0));
  x.fillStyle = s;
  x.fillRect(-r, -r, r * 2, r * 2);

  // 4. Bounce light along the lower-right edge.
  const b = x.createRadialGradient(-r * 0.25, -r * 0.3, r * 0.95, -r * 0.25, -r * 0.3, r * 1.62);
  b.addColorStop(0, "rgba(196,245,170,0)");
  b.addColorStop(0.6, "rgba(196,245,170,0.22)");
  b.addColorStop(1, "rgba(196,245,170,0)");
  x.fillStyle = b;
  x.fillRect(-r, -r, r * 2, r * 2);

  // 5. Ambient occlusion where he meets a surface.
  if (p.ground > 0.01) {
    const a = x.createLinearGradient(0, r, 0, r * 0.35);
    a.addColorStop(0, `rgba(10,30,10,${0.35 * p.ground})`);
    a.addColorStop(1, "rgba(10,30,10,0)");
    x.fillStyle = a;
    x.fillRect(-r, 0, r * 2, r);
  }
  x.restore();
}

/** 6. A broad soft sheen and a small crisp highlight, fixed to the light. */
function drawGloss(x: CanvasRenderingContext2D, r: number, small: boolean) {
  if (small) {
    x.fillStyle = "rgba(255,255,255,0.82)";
    x.beginPath();
    x.ellipse(-r * 0.4, -r * 0.42, Math.max(r * 0.19, 0.9), Math.max(r * 0.13, 0.7), -0.65, 0, Math.PI * 2);
    x.fill();
    return;
  }
  // Broad sheen
  x.save();
  x.translate(-r * 0.3, -r * 0.4);
  x.rotate(-0.65);
  x.scale(1, 0.62);
  const sh = x.createRadialGradient(0, 0, 0, 0, 0, r * 0.62);
  sh.addColorStop(0, "rgba(255,255,255,0.3)");
  sh.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = sh;
  x.beginPath();
  x.arc(0, 0, r * 0.62, 0, Math.PI * 2);
  x.fill();
  x.restore();
  // Crisp specular
  x.save();
  x.translate(-r * 0.4, -r * 0.47);
  x.rotate(-0.65);
  x.scale(1, 0.58);
  const sp = x.createRadialGradient(0, 0, 0, 0, 0, r * 0.2);
  sp.addColorStop(0, "rgba(255,255,255,0.97)");
  sp.addColorStop(0.55, "rgba(255,255,255,0.8)");
  sp.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = sp;
  x.beginPath();
  x.arc(0, 0, r * 0.2, 0, Math.PI * 2);
  x.fill();
  x.restore();
}

function drawBlush(x: CanvasRenderingContext2D, p: StewPose, g: StewGeom) {
  const f = faceDir(p);
  for (const sd of [-1, 1]) {
    const c = onSphere(g.r, f.lon + sd * 0.62, f.lat - 0.24);
    if (c.facing <= 0.05) continue;
    x.fillStyle = `rgba(255,128,140,${0.5 * p.blush * Math.min(1, c.facing * 1.5)})`;
    x.beginPath();
    x.ellipse(c.x, c.y, Math.max(g.r * 0.15 * c.fx, 0.6), Math.max(g.r * 0.085 * c.fy, 0.5), 0, 0, Math.PI * 2);
    x.fill();
  }
}

function drawMouth(x: CanvasRenderingContext2D, p: StewPose) {
  const f = faceDir(p);
  const c = onSphere(p.r, f.lon, f.lat - 0.42);
  if (c.facing <= 0.05) return;
  const m = p.mouth;
  const rx = Math.max(p.r * (0.05 + 0.07 * m), 0.8) * c.fx;
  const ry = Math.max(p.r * (0.055 + 0.1 * m), 0.9) * c.fy;
  x.fillStyle = EYE_INK;
  x.beginPath();
  x.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
  x.fill();
}

function glint(x: CanvasRenderingContext2D, w: number, h: number, big = false) {
  x.fillStyle = "rgba(255,255,255,0.9)";
  x.beginPath();
  x.arc(-w * 0.16, -h * 0.2, w * (big ? 0.26 : 0.19), 0, Math.PI * 2);
  x.fill();
}

function star4(x: CanvasRenderingContext2D, s: number) {
  x.beginPath();
  for (let i = 0; i < 8; i++) {
    const rr = i % 2 ? s * 0.32 : s;
    const a = (i * Math.PI) / 4;
    x.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  x.closePath();
  x.fill();
}

function drawEyes(x: CanvasRenderingContext2D, p: StewPose, g: StewGeom) {
  const { eyeW: w, eyeH: h } = g;
  const detail = !g.small && g.r >= 14;
  const stroke = Math.max(w * 0.42, 1.1);
  x.fillStyle = EYE_INK;
  x.strokeStyle = EYE_INK;
  x.lineCap = "round";
  for (const sd of [-1, 1]) {
    const fx = sd < 0 ? g.fxL : g.fxR;
    if (fx * g.fy <= 0.06) continue; // round the back of the ball
    x.save();
    x.translate(sd < 0 ? g.eyeL : g.eyeR, g.eyeY);
    // Foreshortened by the curve; never thinner than a hairline.
    x.scale(Math.max(fx, 0.18), Math.max(g.fy, 0.3));
    let shape = p.eye;
    if (shape === "wink") shape = sd > 0 ? "happy" : "oval";
    if (shape === "love") shape = "happy";
    switch (shape) {
      case "oval":
      case "wide":
      case "sparkle": {
        const ew = w * (shape === "wide" ? 1.16 : 1);
        const eh = h * (shape === "wide" ? 1.14 : 1);
        const hh = Math.max((eh / 2) * p.open, ew * 0.17);
        if (p.open < 0.22) {
          x.lineWidth = stroke * 0.9;
          x.beginPath();
          x.moveTo(-ew * 0.55, 0);
          x.lineTo(ew * 0.55, 0);
          x.stroke();
        } else {
          x.beginPath();
          x.ellipse(0, 0, ew / 2, hh, 0, 0, Math.PI * 2);
          x.fill();
          if (detail && p.open > 0.6) glint(x, ew, eh, shape !== "oval");
          if (shape === "sparkle" && !g.small) {
            x.save();
            x.translate(ew * 0.45, -eh * 0.5);
            x.rotate(p.t * 2 * sd);
            x.fillStyle = "#FFE27A";
            star4(x, Math.max(w * 0.5, 1.3));
            x.restore();
          }
        }
        break;
      }
      case "dot":
        x.beginPath();
        x.arc(0, 0, Math.max(w * 0.4, 0.95), 0, Math.PI * 2);
        x.fill();
        break;
      case "happy":
        x.lineWidth = stroke;
        x.beginPath();
        x.arc(0, h * 0.24, w * 0.62, Math.PI * 1.08, Math.PI * 1.92);
        x.stroke();
        break;
      case "closed":
        x.lineWidth = stroke * 0.9;
        x.beginPath();
        x.arc(0, -h * 0.1, w * 0.6, Math.PI * 0.12, Math.PI * 0.88);
        x.stroke();
        break;
      case "annoyed":
        x.lineWidth = stroke;
        x.rotate(sd * 0.32);
        x.beginPath();
        x.moveTo(-w * 0.62, 0);
        x.lineTo(w * 0.62, 0);
        x.stroke();
        break;
      case "flat":
        // Worried: short lines slanting down at the outside.
        x.lineWidth = stroke;
        x.rotate(-sd * 0.2);
        x.beginPath();
        x.moveTo(-w * 0.55, h * 0.05);
        x.lineTo(w * 0.55, h * 0.05);
        x.stroke();
        break;
      case "tired":
        x.beginPath();
        x.ellipse(0, h * 0.08, w / 2, (h / 2) * 0.55, 0, 0, Math.PI);
        x.fill();
        x.lineWidth = stroke * 0.7;
        x.beginPath();
        x.moveTo(-w * 0.62, h * 0.06);
        x.lineTo(w * 0.62, h * 0.06);
        x.stroke();
        break;
      case "dizzy": {
        // A pupil going round its own little ring, each eye its own way.
        const a = p.t * 8 * sd;
        const rr = w * 0.48;
        if (!g.small) {
          x.lineWidth = Math.max(w * 0.16, 0.7);
          x.beginPath();
          x.arc(0, 0, rr, 0, Math.PI * 2);
          x.stroke();
        }
        x.beginPath();
        x.arc(Math.cos(a) * rr * 0.55, Math.sin(a) * rr * 0.55, Math.max(w * 0.3, 0.9), 0, Math.PI * 2);
        x.fill();
        break;
      }
    }
    x.restore();
  }
}

export function heartPath(x: CanvasRenderingContext2D, s: number) {
  x.beginPath();
  x.moveTo(0, s * 0.38);
  x.bezierCurveTo(-s * 1.05, -s * 0.15, -s * 0.5, -s * 0.95, 0, -s * 0.38);
  x.bezierCurveTo(s * 0.5, -s * 0.95, s * 1.05, -s * 0.15, 0, s * 0.38);
  x.closePath();
}

/** A soft contact shadow under him on a surface; `lift` 0…1 fades and shrinks it. */
export function drawContactShadow(x: CanvasRenderingContext2D, cx: number, groundY: number, r: number, lift: number) {
  const k = Math.max(0, 1 - lift);
  if (k <= 0.01) return;
  const w = r * (0.6 + 0.35 * k);
  x.save();
  x.translate(cx, groundY);
  x.scale(1, 0.2);
  const g = x.createRadialGradient(0, 0, 0, 0, 0, w);
  g.addColorStop(0, `rgba(0,0,0,${0.38 * k})`);
  g.addColorStop(0.6, `rgba(0,0,0,${0.16 * k})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = g;
  x.beginPath();
  x.arc(0, 0, w, 0, Math.PI * 2);
  x.fill();
  x.restore();
}
