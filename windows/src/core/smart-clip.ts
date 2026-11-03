// Smart clipboard: recognises what the copied text is and offers its decoded
// form. Pure functions; the Tools tab reads the clipboard (Bridge.clipboardText)
// and shows the results.

export type ClipKind = "jwt" | "json" | "base64" | "timestamp" | "url" | "urlencoded" | "color";

export interface ClipResult {
  kind: ClipKind;
  /** English label, translated where shown ("JWT", "JSON", "Unix time"…). */
  label: string;
  /** The decoded / pretty text to show and copy. */
  output: string;
}

/** Larger clipboards are left alone: nothing here should ever take time. */
export const MAX_CLIP = 100 * 1024;

/** Every reading that applies, most specific first; [] for plain text. */
export function analyze(text: string, now = Date.now()): ClipResult[] {
  if (typeof text !== "string" || text.length > MAX_CLIP) return [];
  const s = text.trim();
  if (!s) return [];
  const out: ClipResult[] = [];
  const add = (r: ClipResult | null) => {
    if (r) out.push(r);
  };
  add(jwt(s, now));
  add(url(s));
  add(timestamp(s, now));
  add(color(s));
  if (!out.some((r) => r.kind === "jwt")) add(json(s));
  if (out.length === 0) add(base64(s));
  if (!out.some((r) => r.kind === "url")) add(urlEncoded(s));
  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pretty(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function isObjectLike(v: unknown): v is Record<string, unknown> | unknown[] {
  return typeof v === "object" && v !== null;
}

/** Base64 or base64url to bytes; null when it is not valid. */
function b64Bytes(s: string): Uint8Array | null {
  let b = s.replace(/-/g, "+").replace(/_/g, "/");
  if (b.length % 4 === 1) return null;
  b = b.padEnd(b.length + ((4 - (b.length % 4)) % 4), "=");
  try {
    const bin = atob(b);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Bytes as UTF-8 text when they decode cleanly and read as text; else null. */
function printableUtf8(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (!text) return null;
  let printable = 0;
  let total = 0;
  for (const ch of text) {
    total++;
    const c = ch.codePointAt(0) ?? 0;
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127 && !(c >= 0x80 && c < 0xa0) && c !== 0xfffd)) printable++;
  }
  return printable / total >= 0.95 ? text : null;
}

function dateLine(sec: number): string {
  const d = new Date(sec * 1000);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : String(sec);
}

/** "in 3 days", "2 hours ago", in English: the label is translated where shown, not the output. */
export function relative(ms: number, now: number): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [365 * 86_400_000, "year"],
    [30 * 86_400_000, "month"],
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [size, name] of units) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      const word = `${n} ${name}${n === 1 ? "" : "s"}`;
      return diff > 0 ? `in ${word}` : `${word} ago`;
    }
  }
  return "now";
}

// ── Readers ───────────────────────────────────────────────────────────────────

function jwt(s: string, now: number): ClipResult | null {
  if (!/^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/.test(s)) return null;
  const [h, p] = s.split(".");
  const hb = b64Bytes(h);
  const pb = b64Bytes(p);
  if (!hb || !pb) return null;
  const header = parseJson(printableUtf8(hb) ?? "");
  const payload = parseJson(printableUtf8(pb) ?? "");
  if (!isObjectLike(header) || !isObjectLike(payload) || Array.isArray(header)) return null;
  const lines = [pretty(header), "", pretty(payload)];
  const claims = payload as Record<string, unknown>;
  const notes: string[] = [];
  for (const key of ["iat", "nbf", "exp"]) {
    const v = claims[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      let line = `${key}: ${dateLine(v)}`;
      if (key === "exp" && v * 1000 <= now) line += " (expired)";
      notes.push(line);
    }
  }
  if (notes.length) lines.push("", ...notes);
  return { kind: "jwt", label: "JWT", output: lines.join("\n") };
}

function json(s: string): ClipResult | null {
  if (!/^[[{]/.test(s)) return null;
  const v = parseJson(s);
  if (!isObjectLike(v)) return null;
  return { kind: "json", label: "JSON", output: pretty(v) };
}

function base64(s: string): ClipResult | null {
  if (s.length < 8 || /\s/.test(s)) return null;
  const std = /^[A-Za-z0-9+/]+={0,2}$/.test(s);
  const urlSafe = /^[A-Za-z0-9_-]+$/.test(s);
  if (!std && !urlSafe) return null;
  // Plain words, numbers and hex are valid base64 too: ask for some mix.
  if (/^[0-9]+$/.test(s) || /^[0-9a-fA-F]+$/.test(s) || /^[A-Za-z]+$/.test(s)) return null;
  const bytes = b64Bytes(s);
  if (!bytes || bytes.length < 4) return null;
  const text = printableUtf8(bytes);
  if (text == null) return null;
  const inner = parseJson(text.trim());
  const output = isObjectLike(inner) ? pretty(inner) : text;
  return { kind: "base64", label: /[-_]/.test(s) ? "Base64url" : "Base64", output };
}

const MIN_MS = Date.UTC(2000, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);

function timestamp(s: string, now: number): ClipResult | null {
  const m = /^(\d{9,13})(?:\.\d+)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  // 9–11 digits are seconds, 12–13 milliseconds.
  const ms = m[1].length <= 11 ? n * 1000 : n;
  if (ms < MIN_MS || ms > MAX_MS) return null;
  const d = new Date(ms);
  const output = `${d.toLocaleString()}\n${d.toISOString()}\n${relative(ms, now)}`;
  return { kind: "timestamp", label: "Unix time", output };
}

function url(s: string): ClipResult | null {
  if (!/^https?:\/\/\S+$/i.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const params = [...u.searchParams.entries()];
  const encodedPath = /%[0-9A-Fa-f]{2}/.test(u.pathname);
  if (params.length === 0 && !encodedPath && !/%[0-9A-Fa-f]{2}/.test(u.hash)) return null;
  let path = u.pathname;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    /* keep it encoded */
  }
  const lines = [`${u.origin}${path}`];
  if (params.length) {
    lines.push("");
    for (const [k, v] of params) lines.push(`${k} = ${v}`);
  }
  if (u.hash) {
    let hash = u.hash;
    try {
      hash = decodeURIComponent(u.hash);
    } catch {
      /* keep it encoded */
    }
    lines.push("", hash);
  }
  return { kind: "url", label: "URL", output: lines.join("\n") };
}

function urlEncoded(s: string): ClipResult | null {
  if (!/%[0-9A-Fa-f]{2}/.test(s)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(s.includes(" ") ? s : s.replace(/\+/g, " "));
  } catch {
    return null;
  }
  if (decoded === s) return null;
  return { kind: "urlencoded", label: "URL-encoded", output: decoded };
}

// ── Colors ────────────────────────────────────────────────────────────────────

function hex2(n: number): string {
  return Math.round(n).toString(16).padStart(2, "0");
}

function hsl(r: number, g: number, b: number): string {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let sat = 0;
  if (max !== min) {
    const d = max - min;
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  return `hsl(${Math.round(h)}, ${Math.round(sat * 100)}%, ${Math.round(l * 100)}%)`;
}

function color(s: string): ClipResult | null {
  let r: number, g: number, b: number;
  let a = 1;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(s);
  if (hex) {
    let v = hex[1];
    if (v.length <= 4) v = [...v].map((c) => c + c).join("");
    r = parseInt(v.slice(0, 2), 16);
    g = parseInt(v.slice(2, 4), 16);
    b = parseInt(v.slice(4, 6), 16);
    if (v.length === 8) a = parseInt(v.slice(6, 8), 16) / 255;
  } else if (rgb) {
    [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number);
    if (r > 255 || g > 255 || b > 255) return null;
    if (rgb[4] != null) {
      a = rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
      if (!(a >= 0 && a <= 1)) return null;
    }
  } else {
    return null;
  }
  const alpha = a < 1 ? hex2(a * 255) : "";
  const aText = Math.round(a * 100) / 100;
  const lines = [
    `#${hex2(r)}${hex2(g)}${hex2(b)}${alpha}`,
    a < 1 ? `rgba(${r}, ${g}, ${b}, ${aText})` : `rgb(${r}, ${g}, ${b})`,
    hsl(r, g, b),
  ];
  return { kind: "color", label: "Color", output: lines.join("\n") };
}
