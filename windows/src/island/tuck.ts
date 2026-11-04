// What the tucked pill shows when Pod is folded away over a maximized or
// fullscreen window. A running focus or break timer takes Stew's place as a
// live countdown with a thin progress line. Something that wants attention (a
// fired reminder, a meeting about to start, a fresh download) makes the pill
// glow, with a shimmer passing across it a few times.
//
// Pure rules here; NotchSides (notch.ts) owns the element and the one timer.

import type { FocusState } from "../core/focus";
import type { Meeting, Reminder } from "../core/bridge";

const MIN = 60_000;

/** A meeting glows from 5 minutes before it starts until 2 minutes in. */
export const MEETING_SOON_MS = 5 * MIN;
export const MEETING_LATE_MS = 2 * MIN;

export type TuckAlert = "reminder" | "meeting" | "download";

export interface TuckInput {
  reminders: readonly Reminder[];
  meeting: Meeting | null;
  /** Until when the new download is offered (epoch ms), or null. */
  downloadUntil: number | null;
  /** Which of them are switched on (Settings → Features and right-side items). */
  remindersOn: boolean;
  meetingOn: boolean;
  downloadOn: boolean;
}

/** What the pill glows for, most pressing first; null when nothing is waiting. */
export function tuckAlert(o: TuckInput, now: number): TuckAlert | null {
  if (o.remindersOn && o.reminders.some((r) => r.fired)) return "reminder";
  const m = o.meeting;
  if (o.meetingOn && m && now >= m.start - MEETING_SOON_MS && now < Math.min(m.end, m.start + MEETING_LATE_MS)) {
    return "meeting";
  }
  if (o.downloadOn && o.downloadUntil != null && now < o.downloadUntil) return "download";
  return null;
}

/** Milliseconds until `tuckAlert` can change by itself (the meeting window, the download offer). */
export function tuckAlertChangeIn(o: TuckInput, now: number): number | null {
  const at: number[] = [];
  const m = o.meeting;
  if (o.meetingOn && m) at.push(m.start - MEETING_SOON_MS, Math.min(m.end, m.start + MEETING_LATE_MS));
  if (o.downloadOn && o.downloadUntil != null) at.push(o.downloadUntil);
  const next = at.filter((t) => t > now).map((t) => t - now);
  return next.length ? Math.min(...next) : null;
}

/** The timer's time left as the pill shows it: "24:13", "0:07", "1h05" past an hour. */
export function tuckTime(leftMs: number): string {
  const s = Math.max(0, Math.ceil(leftMs / 1000));
  if (s >= 3600) {
    const m = Math.floor(s / 60);
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
  }
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The share of the phase still to run, 0…1 (the progress line). */
export function tuckProgress(f: FocusState, now: number): number {
  if (f.phase === "off" || !(f.length > 0)) return 0;
  return Math.min(1, Math.max(0, (f.endsAt - now) / f.length));
}

/** A reminder this close shows its countdown on the pill ("🔔 4m"). */
export const SOON_MS = 60 * MIN;

/** The next reminder still to come within SOON_MS (fired ones glow instead). */
export function tuckSoon(reminders: readonly Reminder[], now: number, on: boolean): Reminder | null {
  if (!on) return null;
  let next: Reminder | null = null;
  for (const r of reminders) {
    if (r.fired || r.due <= now || r.due - now > SOON_MS) continue;
    if (!next || r.due < next.due) next = r;
  }
  return next;
}

/** "45s", "4m", "1h" — the narrowest unit the language has, rounded up. */
export function tuckShort(leftMs: number, lang: string): string {
  const s = Math.max(1, Math.ceil(leftMs / 1000));
  const [value, unit] = s < 60 ? [s, "second"] : s < 3600 ? [Math.ceil(s / 60), "minute"] : [Math.ceil(s / 3600), "hour"];
  try {
    return new Intl.NumberFormat(lang, { style: "unit", unit, unitDisplay: "narrow" }).format(value);
  } catch {
    return `${value}${unit[0]}`;
  }
}

/** Milliseconds until `tuckShort` reads differently. */
export function tuckShortChangeIn(leftMs: number): number {
  const s = Math.ceil(leftMs / 1000);
  if (s <= 60) return leftMs % 1000 || 1000;
  const step = s <= 3600 ? 60_000 : 3_600_000;
  return leftMs % step || step;
}

/** A job's progress as the pill shows it: "42%". */
export function tuckPercent(fraction: number): string {
  return `${Math.min(100, Math.max(0, Math.floor(fraction * 100)))}%`;
}
