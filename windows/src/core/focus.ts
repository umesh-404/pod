// Focus timer (Pomodoro): a focus block, then a break. Started from the Tools
// tab, shown on the right of the compact notch while it runs. Lengths come from
// Settings (focusMinutes, breakMinutes).
//
// One setTimeout per phase, nothing ticks: views that show the time left draw
// it from `endsAt`. `{phase, endsAt, length}` is kept in localStorage so a
// reload of the page picks the timer up where it was.

import { State } from "./state";
import { Sound } from "./sound";

export type FocusPhase = "off" | "focus" | "break";

export interface FocusState {
  phase: FocusPhase;
  /** Epoch ms when the current phase ends; 0 when off. */
  endsAt: number;
  /** Total length of the current phase, ms (for a progress ring). */
  length: number;
}

const STORAGE_KEY = "pod.focus";
const OFF: FocusState = { phase: "off", endsAt: 0, length: 0 };

let current: FocusState = OFF;
let timer: ReturnType<typeof setTimeout> | null = null;
let restored = false;
const listeners = new Set<(s: FocusState) => void>();

function minutes(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 24 * 60) : fallback;
}

function focusMs(): number {
  return minutes(State.settings.focusMinutes, 25) * 60_000;
}

function breakMs(): number {
  return minutes(State.settings.breakMinutes, 5) * 60_000;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function persist() {
  const s = storage();
  if (!s) return;
  try {
    if (current.phase === "off") s.removeItem(STORAGE_KEY);
    else s.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* private mode or full: the timer still runs, it just won't survive a reload */
  }
}

function schedule() {
  if (timer != null) clearTimeout(timer);
  timer = null;
  if (current.phase === "off") return;
  timer = setTimeout(phaseEnded, Math.max(0, current.endsAt - Date.now()));
}

function set(next: FocusState, notify = true) {
  const changed = next.phase !== current.phase || next.endsAt !== current.endsAt;
  current = next;
  persist();
  schedule();
  if (changed && notify) for (const cb of [...listeners]) cb(current);
}

function breakFrom(start: number): FocusState {
  const length = breakMs();
  return { phase: "break", endsAt: start + length, length };
}

function phaseEnded() {
  timer = null;
  if (current.phase === "focus") {
    Sound.play("finish");
    set(breakFrom(Date.now()));
  } else if (current.phase === "break") {
    Sound.play("pop");
    set(OFF);
  }
}

/** Picks up a timer a previous page left running (once, on first use). */
function restore() {
  if (restored) return;
  restored = true;
  const s = storage();
  let saved: Partial<FocusState> | null = null;
  try {
    saved = JSON.parse(s?.getItem(STORAGE_KEY) ?? "null");
  } catch {
    saved = null;
  }
  if (!saved || (saved.phase !== "focus" && saved.phase !== "break")) return;
  const endsAt = Number(saved.endsAt);
  if (!Number.isFinite(endsAt) || endsAt <= 0) return;
  const now = Date.now();
  const length = Number(saved.length) > 0 ? Number(saved.length) : saved.phase === "focus" ? focusMs() : breakMs();
  if (endsAt > now) {
    set({ phase: saved.phase, endsAt, length }, false);
  } else if (saved.phase === "focus") {
    // Focus ended while the page was away: the break started then.
    const brk = breakFrom(endsAt);
    set(brk.endsAt > now ? brk : OFF, false);
  } else {
    set(OFF, false);
  }
}

export const Focus = {
  state(): FocusState {
    restore();
    return { ...current };
  },
  start(): void {
    restore();
    const length = focusMs();
    set({ phase: "focus", endsAt: Date.now() + length, length });
  },
  stop(): void {
    restore();
    set(OFF);
  },
  /** Skips to the next phase (focus → break → off). */
  skip(): void {
    restore();
    if (current.phase === "focus") set(breakFrom(Date.now()));
    else if (current.phase === "break") set(OFF);
  },
  /** Called on every phase change (not every second); returns an unsubscribe. */
  on(cb: (s: FocusState) => void): () => void {
    restore();
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};

/** Tests: forget everything, as a fresh page would. */
export function _resetFocusForTests() {
  if (timer != null) clearTimeout(timer);
  timer = null;
  current = OFF;
  restored = false;
  listeners.clear();
}
