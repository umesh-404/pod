// What the four island tabs share: their width, event subscriptions that live
// only while a tab is shown, and the small formatters (sizes, ages, times,
// countdowns, middle-ellipsis names).

import * as Layout from "../../core/layout";
import { onEvent } from "../../core/bridge";
import { dayMonth, language, t, weekdayShort } from "../../i18n/i18n";

/** The island's tab width (core/layout.ts exports TAB_WIDTH; 640 until it does). */
export function tabWidth(): number {
  const w = (Layout as unknown as Record<string, unknown>).TAB_WIDTH;
  return typeof w === "number" && w > 0 ? w : 640;
}

export const MIN_H = 160;
export const MAX_H = 420;

export function clampHeight(px: number): number {
  return Math.round(Math.max(MIN_H, Math.min(MAX_H, px)));
}

/**
 * Listens to a Rust event until the returned function is called. Safe when the
 * tab hides before the listener is registered: it is dropped as soon as it is.
 */
export function listenWhile<T>(name: string, handler: (payload: T) => void): () => void {
  let off: (() => void) | null = null;
  let dead = false;
  void onEvent<T>(name, (p) => {
    if (!dead) handler(p);
  }).then((unlisten) => {
    if (dead) safeUnlisten(unlisten);
    else off = unlisten;
  });
  return () => {
    dead = true;
    if (off) safeUnlisten(off);
    off = null;
  };
}

/** Tauri's unlisten is async underneath: its failure must never surface. */
function safeUnlisten(fn: () => unknown) {
  try {
    const r = fn();
    if (r instanceof Promise) r.catch(() => {});
  } catch {
    /* already gone */
  }
}

/** Pauses the island's auto-close while held; release is idempotent. */
export function holder(host: { hold(on: boolean): void }) {
  let held = false;
  return {
    set(on: boolean) {
      if (on === held) return;
      held = on;
      host.hold(on);
    },
    get held() {
      return held;
    },
  };
}

export function reducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// ── Formatters ────────────────────────────────────────────────────────────────

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** "just now", "5 min ago", "3 h ago", then the day ("Oct 9"). */
export function formatAge(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t("just now");
  if (min < 60) return t("{n} min ago", { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("{n} h ago", { n: h });
  const d = new Date(ms);
  return dayMonth(d.getMonth(), d.getDate());
}

/** "4:00 PM" in the interface language. */
export function formatTime(ms: number): string {
  try {
    return new Intl.DateTimeFormat(language(), { hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  } catch {
    const d = new Date(ms);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "Today 4:00 PM", "Tomorrow 9:00 AM", "Fri 9:00 AM", "Oct 9 9:00 AM". */
export function formatDue(ms: number, now = Date.now()): string {
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / 86_400_000);
  const time = formatTime(ms);
  const d = new Date(ms);
  if (days === 0) return `${t("Today")} ${time}`;
  if (days === 1) return `${t("Tomorrow")} ${time}`;
  if (days > 1 && days < 7) return `${weekdayShort(d.getDay())} ${time}`;
  return `${dayMonth(d.getMonth(), d.getDate())} ${time}`;
}

/** "in 2 d 4 h", "in 3 h 05", "in 12 min", "Overdue". Minute precision. */
export function formatCountdown(due: number, now = Date.now()): string {
  const diff = due - now;
  if (diff <= 0) return t("Overdue");
  const totalMin = Math.ceil(diff / 60_000);
  if (totalMin < 60) return t("in {m} min", { m: totalMin });
  const totalH = Math.floor(totalMin / 60);
  if (totalH < 24) return t("in {h} h {m}", { h: totalH, m: String(totalMin % 60).padStart(2, "0") });
  return t("in {d} d {h} h", { d: Math.floor(totalH / 24), h: totalH % 24 });
}

/** "a-very-long-file-na…e.png": keeps the start and the extension. */
export function middleEllipsis(name: string, max = 22): string {
  const chars = [...name];
  if (chars.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 8 ? [...name.slice(dot)] : [];
  const tail = Math.max(ext.length + 2, Math.floor(max / 3));
  const head = Math.max(1, max - tail - 1);
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

/** The error a rejected Bridge call carries, as text. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
