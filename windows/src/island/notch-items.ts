// What the compact notch's sides show, and the side itself (two sliding
// layers), kept apart from the island so the Settings window's live preview
// (settings/notch-preview.ts) draws the very same items with the very same
// markup. No timers, events or Rust here: the island (notch.ts) and the
// preview each drive a SideView with their own clock.
//
// Tested in tests/notch.test.mjs.

import type { DevServer, Glance, InUse, Meeting, NewDownload, NowPlaying, Reminder } from "../core/bridge";
import type { FocusState } from "../core/focus";
import type { FileAction } from "../core/state";
import { h, svg, clear } from "../views/dom";
import { ICONS } from "../views/icons";
import { language, t } from "../i18n/i18n";
import { fileActionProgress } from "./file-actions";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A new download stays on its side this long. */
export const DOWNLOAD_TTL_MS = 2 * MIN;

/**
 * The items the right side knew before either side could hold any item, in no
 * particular order ("privacy" is a feature with its own lights now, never an
 * item; older settings files may still list it).
 */
export const RIGHT_ITEM_IDS = [
  "job", "timer", "meeting", "media", "shelf", "glance", "privacy", "download", "devservers",
] as const;
export type RightItemId = (typeof RIGHT_ITEM_IDS)[number];

/**
 * Every item a side of the notch can show. These are stored in settings.json
 * (`leftWidgets`, `rightWidgets`, `leftOff`, `rightOff`): never rename one.
 */
export const SIDE_ITEM_IDS = [
  "reminder", "job", "timer", "meeting", "media", "shelf", "glance", "download", "devservers",
] as const;
export type SideItemId = (typeof SIDE_ITEM_IDS)[number];

export function isSideItem(id: unknown): id is SideItemId {
  return typeof id === "string" && (SIDE_ITEM_IDS as readonly string[]).includes(id);
}

/** The Settings → Features switch an item goes away with (most share their id). */
export function featureOf(id: string): string {
  if (id === "reminder") return "reminders";
  if (id === "timer") return "focus";
  return id;
}

export type NotchSideName = "left" | "right";

/** What the notch settings say about the two sides (a subset of Settings). */
export interface NotchSideSettings {
  leftWidgets?: readonly string[];
  rightWidgets?: readonly string[];
}

/**
 * The items switched on, per side, in their turn's order. Unknown ids and
 * "privacy" are left out, and an id listed on both sides (a hand-edited file)
 * stays on the left only.
 */
export function notchLayout(s: NotchSideSettings): { left: SideItemId[]; right: SideItemId[] } {
  const seen = new Set<string>();
  const take = (list: readonly string[] | undefined) => {
    const out: SideItemId[] = [];
    for (const id of list ?? []) {
      if (!isSideItem(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };
  const left = take(s.leftWidgets ?? ["reminder"]);
  return { left, right: take(s.rightWidgets) };
}

/** A side's turn, ms, from its seconds in the settings (6 s when unset or too short). */
export function rotateMsOf(seconds: unknown): number {
  const s = Number(seconds);
  return (Number.isFinite(s) && s >= 2 ? s : 6) * 1000;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Time left as the notch says it: "2d 4h", "3h 20m", "34m 05s". */
export function countdownText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days >= 1) return t("{days}d {hours}h", { days, hours });
  if (hours >= 1) return t("{hours}h {minutes}m", { hours, minutes });
  return t("{minutes}m {seconds}s", { minutes, seconds: pad2(s % 60) });
}

/** In how many ms countdownText(ms) next changes. */
export function countdownChangeIn(ms: number): number {
  if (ms <= 0) return 0;
  const step = ms < HOUR ? 1000 : MIN;
  return ms % step || step;
}

export interface LeftPick {
  reminder: Reminder;
  /** Due and not handled yet: it pulses, and a click opens the Reminders tab. */
  fired: boolean;
}

/** The reminder item: the latest fired reminder, else the nearest deadline to come. */
export function pickLeft(reminders: readonly Reminder[], now: number): LeftPick | null {
  let fired: Reminder | null = null;
  let next: Reminder | null = null;
  for (const r of reminders) {
    if (r.fired) {
      if (!fired || r.due > fired.due) fired = r;
    } else if (r.deadline && r.due > now && (!next || r.due < next.due)) {
      next = r;
    }
  }
  if (fired) return { reminder: fired, fired: true };
  return next ? { reminder: next, fired: false } : null;
}

/** What the reminder item says for a pick. */
export function leftText(pick: LeftPick, now: number): string {
  if (pick.fired) return pick.reminder.text;
  return `${pick.reminder.text} · ${countdownText(pick.reminder.due - now)}`;
}

export interface NotchData {
  job: FileAction | null;
  focus: FocusState;
  meeting: Meeting | null;
  media: NowPlaying | null;
  shelfCount: number;
  glance: Glance | null;
  privacy: InUse | null;
  download: { item: NewDownload; until: number } | null;
  devservers: readonly DevServer[];
  /** For the reminder item. */
  reminders?: readonly Reminder[];
}

export interface SideItem {
  id: SideItemId;
  text: string;
  icon?: keyof typeof ICONS;
  /** Drawn as a stroke rather than filled. */
  stroke?: number;
  /** A small action after the text ("Add to shelf"). */
  chip?: string;
  /** A coloured dot before the text: a reminder that is due (pulsing). */
  dot?: "fired";
  /** The tooltip, when it isn't the text. */
  title?: string;
  /** In how many ms the text changes by itself; undefined: only on an event. */
  changeIn?: number;
}

function jobItem(s: FileAction | null): SideItem | null {
  if (!s) return null;
  const p = fileActionProgress(s);
  const pct = p == null ? "" : `${Math.round(p * 100)} %`;
  switch (s.kind) {
    case "converting":
      return { id: "job", text: `${s.format.label} · ${pct}`, icon: "convert", stroke: 1.9 };
    case "downloading":
      return { id: "job", text: `ffmpeg · ${pct}`, icon: "download", stroke: 1.9 };
    case "working":
      return { id: "job", text: s.title, icon: "convert", stroke: 1.9 };
    default:
      return null;
  }
}

function timerItem(f: FocusState, now: number): SideItem | null {
  if (f.phase === "off" || !(f.endsAt > 0)) return null;
  const left = Math.max(0, f.endsAt - now);
  const s = Math.ceil(left / 1000);
  const time = `${Math.floor(s / 60)}:${pad2(s % 60)}`;
  const text = f.phase === "focus" ? t("Focus · {time}", { time }) : t("Break · {time}", { time });
  return { id: "timer", text, icon: "timer", changeIn: left % 1000 || 1000 };
}

function meetingItem(m: Meeting | null, now: number): SideItem | null {
  if (!m || !m.title) return null;
  const until = m.start - now;
  if (until <= 0) {
    if (now >= m.end) return null;
    return { id: "meeting", text: t("{title} · now", { title: m.title }), icon: "calendar", stroke: 1.7, changeIn: m.end - now };
  }
  if (until <= HOUR) {
    const minutes = Math.max(1, Math.ceil(until / MIN));
    return {
      id: "meeting", text: t("{title} · in {minutes} min", { title: m.title, minutes }),
      icon: "calendar", stroke: 1.7, changeIn: until % MIN || MIN,
    };
  }
  if (until > 12 * HOUR) return null;
  let time: string;
  try {
    time = new Date(m.start).toLocaleTimeString(language(), { hour: "2-digit", minute: "2-digit" });
  } catch {
    time = new Date(m.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return { id: "meeting", text: t("{title} · {time}", { title: m.title, time }), icon: "calendar", stroke: 1.7, changeIn: until - HOUR };
}

function glanceItem(g: Glance | null): SideItem | null {
  if (!g) return null;
  const cpu = Math.round(g.cpu);
  const ram = g.ramTotal > 0 ? Math.round((g.ramUsed / g.ramTotal) * 100) : 0;
  const text = g.battery
    ? t("CPU {cpu}% · RAM {ram}% · Battery {battery}%", { cpu, ram, battery: Math.round(g.battery.percent) })
    : t("CPU {cpu}% · RAM {ram}%", { cpu, ram });
  return { id: "glance", text, icon: "gauge", stroke: 1.8 };
}

function reminderItem(reminders: readonly Reminder[] | undefined, now: number): SideItem | null {
  const pick = pickLeft(reminders ?? [], now);
  if (!pick) return null;
  return {
    id: "reminder",
    text: leftText(pick, now),
    title: pick.reminder.text,
    ...(pick.fired ? { dot: "fired" as const } : { changeIn: countdownChangeIn(pick.reminder.due - now) || 1000 }),
  };
}

/** One item, or null when it has nothing to show. */
export function sideItem(id: SideItemId, d: NotchData, now: number): SideItem | null {
  switch (id) {
    case "reminder":
      return reminderItem(d.reminders, now);
    case "job":
      return jobItem(d.job);
    case "timer":
      return timerItem(d.focus, now);
    case "meeting":
      return meetingItem(d.meeting, now);
    case "media":
      return d.media?.title ? { id, text: d.media.title, icon: d.media.playing ? "pause" : "play" } : null;
    case "shelf":
      return d.shelfCount > 0 ? { id, text: t("Shelf · {count}", { count: d.shelfCount }), icon: "tray", stroke: 1.7 } : null;
    case "glance":
      return glanceItem(d.glance);
    case "download":
      if (!d.download || d.download.until <= now) return null;
      return {
        id, text: d.download.item.name, icon: "download", stroke: 1.9, chip: t("Add to shelf"),
        changeIn: d.download.until - now,
      };
    case "devservers": {
      const first = d.devservers[0];
      if (!first) return null;
      const more = d.devservers.length > 1 ? ` +${d.devservers.length - 1}` : "";
      return { id, text: `:${first.port} ${first.process}${more}`, icon: "terminal", stroke: 1.9 };
    }
  }
}

/**
 * A side's items with something to show, in `order` (the side's list in the
 * settings), leaving out the ones whose feature is `disabled`. The camera and
 * microphone have their own lights at the right end, never a turn.
 */
export function sideItems(order: readonly string[], disabled: readonly string[], d: NotchData, now: number): SideItem[] {
  const off = new Set(disabled);
  const out: SideItem[] = [];
  for (const id of new Set(order)) {
    if (!isSideItem(id) || off.has(featureOf(id))) continue;
    const item = sideItem(id, d, now);
    if (item) out.push(item);
  }
  return out;
}

/** The right side's items: `sideItems`, under the name the right side always had. */
export const rightItems = sideItems;

/** The item after `current` in the turn, or the first. */
export function nextItem(items: readonly { id: SideItemId }[], current: SideItemId | null): SideItemId | null {
  if (items.length === 0) return null;
  const at = items.findIndex((i) => i.id === current);
  return items[(at + 1) % items.length].id;
}

// ── A side on screen ──────────────────────────────────────────────────────────

/** One of a side's two layers: what it shows, as a key, so a redraw is skipped when nothing changed. */
interface Layer {
  el: HTMLElement;
  key: string;
  text: HTMLElement | null;
}

/**
 * One side of the compact notch: two layers, the item on screen in front. A
 * new item slides up into place as the last one leaves (~240 ms, notch.css);
 * the same item with a new text is redrawn in place. The side takes turns
 * between its items every `rotateMs`, unless held (the pointer is over the
 * notch). Whoever owns it calls `update` when something changed and again
 * after the delay `waits` gives.
 */
export class SideView {
  readonly el: HTMLElement;
  private layers: [Layer, Layer];
  private front = 0;
  /** The item on screen, or null. */
  shownId: SideItemId | null = null;
  private items: SideItem[] = [];
  private rotateAt = 0;

  constructor(side: NotchSideName) {
    const layer = (): Layer => ({ el: h("div", { class: "ns-layer gone" }), key: "", text: null });
    this.layers = [layer(), layer()];
    this.el = h("div", { class: `notch-side ${side}` }, this.layers[0].el, this.layers[1].el);
  }

  /** The item on screen. */
  shown(): SideItem | null {
    return this.items.find((i) => i.id === this.shownId) ?? null;
  }

  /**
   * Shows `items` (those with something to show, in order): the one on screen
   * stays while it is there and its turn lasts. True when what is on screen
   * changed, so its width may have.
   */
  update(items: SideItem[], now: number, held: boolean, rotateMs: number): boolean {
    this.items = items;
    let id = this.shownId;
    if (!items.some((i) => i.id === id)) id = items[0]?.id ?? null;
    else if (now >= this.rotateAt && !held && items.length > 1) id = nextItem(items, id);
    if (id !== this.shownId) this.rotateAt = now + rotateMs;
    const item = items.find((i) => i.id === id) ?? null;
    const changed = this.show(item, id !== this.shownId);
    this.shownId = id;
    this.el.classList.toggle("on", item != null);
    return changed;
  }

  /** A full turn again for the item on screen (the pointer left the notch). */
  restartTurn(now: number, rotateMs: number) {
    this.rotateAt = now + rotateMs;
  }

  /** In how many ms this side changes by itself: its text, or its turn. */
  waits(now: number, held: boolean): number[] {
    const out: number[] = [];
    const shown = this.shown();
    if (shown?.changeIn != null) out.push(Math.max(250, shown.changeIn));
    if (this.items.length > 1 && !held) out.push(Math.max(250, this.rotateAt - now));
    return out;
  }

  /**
   * The width the item on screen needs, px, whatever room its side has now:
   * its layer is as wide as the side allows and its text ends in an ellipsis
   * there, so the text's own scroll width stands in for its cut width. These
   * are whole pixels, each rounded: a pixel more (two when the text was cut)
   * keeps a text that needs 182.4 px from ending in an ellipsis in a wing it
   * was measured to fit. Read once per change, never per frame.
   */
  width(): number {
    const front = this.layers[this.front];
    if (!front.key) return 0;
    const cut = front.text ? front.text.offsetWidth : 0;
    const full = front.text ? front.text.scrollWidth : 0;
    return Math.ceil(front.el.offsetWidth - cut + Math.max(cut, full)) + (full > cut ? 2 : 1);
  }

  /** Puts `item` on the front layer: in place when it is the same item, with the turn's slide otherwise. */
  private show(item: SideItem | null, turn: boolean): boolean {
    const key = item ? `${item.id}|${item.text}|${item.icon ?? ""}|${item.chip ?? ""}|${item.dot ?? ""}|${item.title ?? ""}` : "";
    const front = this.layers[this.front];
    if (!turn && front.key === key) return false;
    if (!item) {
      front.el.classList.add("gone");
      front.key = "";
      return true;
    }
    if (!turn && front.key) {
      fill(front, item, key);
      return true;
    }
    // The old one slides up and out, the new one in from below.
    front.el.classList.add("gone");
    this.front = 1 - this.front;
    const next = this.layers[this.front];
    fill(next, item, key);
    next.el.style.transition = "none";
    next.el.classList.remove("gone");
    next.el.classList.add("enter");
    void next.el.offsetWidth; // the start of the slide, once per turn
    next.el.style.transition = "";
    next.el.classList.remove("enter");
    return true;
  }
}

function fill(layer: Layer, item: SideItem, key: string) {
  layer.key = key;
  clear(layer.el);
  if (item.dot) layer.el.append(h("span", { class: `ns-dot ${item.dot}` }));
  if (item.icon) layer.el.append(h("span", { class: "ns-icon" }, svg(ICONS[item.icon], 11, { stroke: item.stroke })));
  layer.text = h("span", { class: "ns-text", text: item.text });
  layer.el.append(layer.text);
  if (item.chip) layer.el.append(h("span", { class: "ns-chip", text: item.chip }));
  layer.el.title = item.title ?? item.text;
  layer.el.classList.toggle("clickable", item.id !== "glance");
  layer.el.dataset.item = item.id;
}
