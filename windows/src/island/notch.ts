// The compact notch's two sides, around Mochi.
//
// LEFT: the next reminder — a fired one first (pulsing; a click opens the
// Reminders tab, where Done and Snooze are), else the nearest deadline as a
// countdown ("Essay · 2d 4h"), else nothing.
// RIGHT: live items from `settings.rightWidgets`, taking turns every
// `rotateSeconds` (a short crossfade and slide); a microphone or camera in use
// preempts the rotation. An item with nothing to show is skipped.
//
// Efficiency: one timer for the whole notch, set for the next moment some text
// on screen changes (a minute step, a second only where a countdown under an
// hour or the focus timer shows seconds, the next turn, a download's expiry)
// and only while the compact island is up. The watchers in Rust (media,
// glance, privacy, downloads, dev servers) run only for the items turned on and
// only while the island is not hidden. Widths are measured once per change of
// text, never per frame.

import {
  Bridge, onEvent,
  type DevServer, type Glance, type InUse, type Meeting, type NewDownload, type NowPlaying, type Reminder, type ShelfItem,
} from "../core/bridge";
import { Focus, type FocusState } from "../core/focus";
import { COMPACT_SIDE_MAX, TUCK_MAX_W, TUCK_W, type IslandMode, type TuckShape } from "../core/layout";
import { Sound } from "../core/sound";
import { State, type FileAction } from "../core/state";
import { h, svg, clear } from "../views/dom";
import { ICONS } from "../views/icons";
import type { TabId } from "../views/tabs/tab";
import { language, t } from "../i18n/i18n";
import { fileActionProgress } from "./file-actions";
import { tuckAlert, tuckAlertChangeIn, tuckProgress, tuckTime, type TuckInput } from "./tuck";

// ── Pure pieces (tests/notch.test.mjs) ────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A new download stays on the right this long. */
export const DOWNLOAD_TTL_MS = 2 * MIN;

/** The items the right side knows, in no particular order. */
export const RIGHT_ITEM_IDS = [
  "job", "timer", "meeting", "media", "shelf", "glance", "privacy", "download", "devservers",
] as const;
export type RightItemId = (typeof RIGHT_ITEM_IDS)[number];

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

/** The left side: the latest fired reminder, else the nearest deadline to come. */
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

/** What the left side says for a pick. */
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
}

export interface SideItem {
  id: RightItemId;
  text: string;
  icon?: keyof typeof ICONS;
  /** Drawn as a stroke rather than filled. */
  stroke?: number;
  /** A small action after the text ("Add to shelf"). */
  chip?: string;
  /** The coloured dot of a microphone (orange) or camera (green) in use. */
  dot?: "mic" | "camera";
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

/**
 * The right side's items with something to show, in `order` (settings.rightWidgets),
 * leaving out `disabled` features. A microphone or camera in use preempts them all.
 */
export function rightItems(order: readonly string[], disabled: readonly string[], d: NotchData, now: number): SideItem[] {
  const off = new Set(disabled);
  // The camera and microphone have their own lights at the right end (NotchSides.privacyEl).
  const on = order.filter((id): id is RightItemId =>
    (RIGHT_ITEM_IDS as readonly string[]).includes(id) && id !== "privacy" && !off.has(id));
  const out: SideItem[] = [];
  for (const id of new Set(on)) {
    let item: SideItem | null = null;
    switch (id) {
      case "job":
        item = jobItem(d.job);
        break;
      case "timer":
        item = timerItem(d.focus, now);
        break;
      case "meeting":
        item = meetingItem(d.meeting, now);
        break;
      case "media":
        if (d.media?.title) item = { id, text: d.media.title, icon: d.media.playing ? "pause" : "play" };
        break;
      case "shelf":
        if (d.shelfCount > 0) item = { id, text: t("Shelf · {count}", { count: d.shelfCount }), icon: "tray", stroke: 1.7 };
        break;
      case "glance":
        item = glanceItem(d.glance);
        break;
      case "download":
        if (d.download && d.download.until > now) {
          item = {
            id, text: d.download.item.name, icon: "download", stroke: 1.9, chip: t("Add to shelf"),
            changeIn: d.download.until - now,
          };
        }
        break;
      case "devservers": {
        const first = d.devservers[0];
        if (first) {
          const more = d.devservers.length > 1 ? ` +${d.devservers.length - 1}` : "";
          item = { id, text: `:${first.port} ${first.process}${more}`, icon: "terminal", stroke: 1.9 };
        }
        break;
      }
      case "privacy":
        break;
    }
    if (item) out.push(item);
  }
  return out;
}

/** The item after `current` in the turn, or the first. */
export function nextItem(items: readonly SideItem[], current: RightItemId | null): RightItemId | null {
  if (items.length === 0) return null;
  const at = items.findIndex((i) => i.id === current);
  return items[(at + 1) % items.length].id;
}

// ── Controller ────────────────────────────────────────────────────────────────

/** What the sides need from the island. */
export interface NotchHost {
  openTab(id: TabId): void;
  /** The running job's card (a conversion, a zip…). */
  showJob(): void;
  /** Brings the compact island up from hidden. */
  reveal(): void;
  /** The sides' widths changed: the compact island springs to fit. */
  sidesResized(leftW: number, rightW: number): void;
  /** The tucked pill's size or Mochi's place in it changed (a timer, an alert's icon). */
  tuckChanged(shape: TuckShape): void;
}

/** Items backed by a watcher in Rust, turned on only while shown. */
const WATCHERS: Partial<Record<RightItemId, (on: boolean) => unknown>> = {
  media: (on) => Bridge.mediaWatch(on),
  glance: (on) => Bridge.glanceWatch(on),
  privacy: (on) => Bridge.privacyWatch(on),
  download: (on) => Bridge.downloadsWatch(on),
  devservers: (on) => Bridge.devserversWatch(on),
};

/** Room the stacked camera and microphone lights take at the right end, px. */
const PRIVACY_W = 16;

/** The right side's turn and its slide: ~240 ms (style.css, .ns-layer). */
interface Layer {
  el: HTMLElement;
  key: string;
}

export class NotchSides {
  private host: NotchHost;
  readonly leftEl: HTMLElement;
  readonly rightEl: HTMLElement;
  private leftText: HTMLElement;
  private leftContent: HTMLElement;
  /** The microphone and camera lights, stacked at the island's right end. */
  readonly privacyEl: HTMLElement;
  /** The tucked pill's face: a timer's countdown, and the glow when something waits (tuck.ts). */
  readonly tuckEl: HTMLElement;
  private tuckRow: HTMLElement;
  private tuckBot: HTMLElement;
  private tuckTimeEl: HTMLElement;
  private tuckArc: SVGElement;
  private tuckIcon: HTMLElement;
  private tuckIconKind = "";
  /** The pill's size and Mochi's place in it, as last reported to the island. */
  tuckShape: TuckShape = { w: TUCK_W, botCx: TUCK_W / 2 };
  private micEl: HTMLElement;
  private camEl: HTMLElement;
  private layers: [Layer, Layer];
  private front = 0;

  private reminders: Reminder[] = [];
  private data: NotchData = {
    job: null, focus: { phase: "off", endsAt: 0, length: 0 }, meeting: null, media: null, shelfCount: 0,
    glance: null, privacy: null, download: null, devservers: [],
  };

  private mode: IslandMode = "hidden";
  private hovered = false;
  private shownId: RightItemId | null = null;
  private items: SideItem[] = [];
  private rotateAt = 0;
  private timer: number | null = null;
  private watching = new Set<RightItemId>();
  private leftShown: LeftPick | null = null;
  private widths = { left: -1, right: -1 };
  private calendarAsked = false;

  constructor(host: NotchHost) {
    this.host = host;
    this.leftText = h("span", { class: "ns-text" });
    this.leftContent = h("span", { class: "ns-content" }, h("span", { class: "ns-dot" }), this.leftText);
    this.leftEl = h("div", { class: "notch-side left" }, this.leftContent);
    this.micEl = h("span", { class: "ns-light mic" }, svg(ICONS.mic, 9, { stroke: 2.4 }));
    this.camEl = h("span", { class: "ns-light camera" }, svg(ICONS.camera, 9, { stroke: 2.4 }));
    this.privacyEl = h("div", { class: "ns-privacy" }, this.micEl, this.camEl);
    const layer = () => ({ el: h("div", { class: "ns-layer gone" }), key: "" });
    this.layers = [layer(), layer()];
    this.rightEl = h("div", { class: "notch-side right" }, this.layers[0].el, this.layers[1].el);
    // The pill's row: Mochi's slot (his canvas is drawn over it), a timer's ring
    // and time, and the icon of what is waiting. The pill is as wide as the row.
    this.tuckBot = h("i", { class: "tuck-bot" });
    this.tuckTimeEl = h("span", { class: "tuck-time" });
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    ring.setAttribute("class", "tuck-ring");
    ring.setAttribute("viewBox", "0 0 12 12");
    const circle = (cls: string) => {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("class", cls);
      c.setAttribute("cx", "6");
      c.setAttribute("cy", "6");
      c.setAttribute("r", "4.6");
      c.setAttribute("pathLength", "100");
      ring.append(c);
      return c;
    };
    circle("tuck-ring-track");
    this.tuckArc = circle("tuck-ring-arc");
    this.tuckIcon = h("span", { class: "tuck-icon" });
    this.tuckRow = h("div", { class: "tuck-row" }, this.tuckBot, ring, this.tuckTimeEl, this.tuckIcon);
    this.tuckEl = h(
      "div",
      { class: "tuck-face", "aria-hidden": "true" },
      h("i", { class: "tuck-glow" }),
      h("div", { class: "tuck-inner" }, h("i", { class: "tuck-shine" }), this.tuckRow),
    );

    // A press on a side does the side's thing rather than opening the island.
    this.leftEl.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !this.leftShown) return;
      e.stopPropagation();
      Sound.resume();
      this.host.openTab("reminders");
    });
    this.rightEl.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !this.shownId) return;
      if (this.click(this.shownId)) e.stopPropagation();
    });

    void onEvent<Reminder[]>("reminders-changed", (list) => {
      this.reminders = Array.isArray(list) ? list : [];
      this.refresh();
    });
    void onEvent<Reminder>("reminder-due", (r) => this.due(r));
    void onEvent<NowPlaying | null>("media", (m) => this.put({ media: m }));
    void onEvent<Glance>("system-glance", (g) => this.put({ glance: g }));
    void onEvent<InUse>("privacy", (p) => this.put({ privacy: p }));
    void onEvent<Meeting | null>("next-meeting", (m) => this.put({ meeting: m }));
    void onEvent<NewDownload>("download-new", (item) =>
      this.put({ download: { item, until: Date.now() + DOWNLOAD_TTL_MS } }));
    void onEvent<DevServer[]>("dev-servers", (list) => this.put({ devservers: Array.isArray(list) ? list : [] }));
    void onEvent<ShelfItem[]>("shelf-changed", (list) => this.put({ shelfCount: Array.isArray(list) ? list.length : 0 }));
    Focus.on((f) => this.put({ focus: f }));
  }

  /** After boot: what is already there (reminders missed while Pod was off are `fired`). */
  async start() {
    const [reminders, shelf] = await Promise.all([Bridge.remindersList(), Bridge.shelfList()]);
    if (reminders) this.reminders = reminders;
    if (shelf) this.data.shelfCount = shelf.length;
    this.data.focus = Focus.state();
    this.refresh();
  }

  /** The island's mode: the sides show in compact; watchers run unless hidden. */
  setMode(mode: IslandMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.applyWatchers();
    this.refresh();
  }

  /** The pointer is over the island: the turn waits. */
  setHovered(on: boolean) {
    if (on === this.hovered) return;
    this.hovered = on;
    // Leaving gives the item on screen a full turn again.
    if (!on) this.rotateAt = Date.now() + this.rotateMs();
    this.schedule();
  }

  /** Settings changed (items, order, features, turn length). */
  settingsChanged() {
    this.applyWatchers();
    this.refresh();
  }

  /** The island's state changed (a job's progress): redraw if it shows. */
  sync() {
    if (this.data.job === State.fileAction) return;
    this.data.job = State.fileAction;
    if (this.mode === "compact") this.render(Date.now());
  }

  private enabledRight(): RightItemId[] {
    const off = new Set(State.settings.disabledFeatures ?? []);
    return (State.settings.rightWidgets ?? [])
      .filter((id): id is RightItemId => (RIGHT_ITEM_IDS as readonly string[]).includes(id) && !off.has(id));
  }

  /** The camera and microphone lights (Settings → Features). */
  private privacyOn(): boolean {
    return !(State.settings.disabledFeatures ?? []).includes("privacy");
  }

  private leftEnabled(): boolean {
    return !(State.settings.disabledFeatures ?? []).includes("reminders");
  }

  private rotateMs(): number {
    const s = Number(State.settings.rotateSeconds);
    return (Number.isFinite(s) && s >= 2 ? s : 6) * 1000;
  }

  private applyWatchers() {
    const visible = this.mode !== "hidden";
    const want = new Set(visible ? this.enabledRight().filter((id) => WATCHERS[id]) : []);
    if (visible && this.privacyOn()) want.add("privacy");
    for (const id of Object.keys(WATCHERS) as RightItemId[]) {
      const on = want.has(id);
      if (on === this.watching.has(id)) continue;
      if (on) this.watching.add(id);
      else this.watching.delete(id);
      void WATCHERS[id]?.(on);
      if (on) this.fetchNow(id);
    }
    // The calendar has no watcher: one look when the meeting item first shows.
    if (visible && !this.calendarAsked && this.enabledRight().includes("meeting") && (State.settings.calendarUrls ?? []).length > 0) {
      this.calendarAsked = true;
      Bridge.calendarRefresh().then((m) => this.put({ meeting: m }), () => {});
    }
  }

  private fetchNow(id: RightItemId) {
    switch (id) {
      case "media":
        void Bridge.mediaNow().then((m) => this.put({ media: m }));
        break;
      case "privacy":
        void Bridge.privacyNow().then((p) => p && this.put({ privacy: p }));
        break;
      case "devservers":
        void Bridge.devserversNow().then((list) => list && this.put({ devservers: list }));
        break;
      default:
        break;
    }
  }

  private put(patch: Partial<NotchData>) {
    Object.assign(this.data, patch);
    this.refresh();
  }

  private due(r: Reminder) {
    if (!r) return;
    const fired = { ...r, fired: true };
    const at = this.reminders.findIndex((x) => x.id === r.id);
    if (at >= 0) this.reminders[at] = fired;
    else this.reminders.push(fired);
    if (this.leftEnabled()) {
      Sound.play("pop");
      this.host.reveal();
    }
    this.refresh();
  }

  /** A press on the right side. True when the item took it. */
  private click(id: RightItemId): boolean {
    Sound.resume();
    switch (id) {
      case "job":
        this.host.showJob();
        return true;
      case "timer":
        this.host.openTab("tools");
        return true;
      case "shelf":
        this.host.openTab("shelf");
        return true;
      case "meeting": {
        const link = this.data.meeting?.link;
        if (!link) return false;
        void Bridge.openUrl(link);
        return true;
      }
      case "media": {
        const m = this.data.media;
        if (!m) return false;
        Bridge.mediaControl("playpause").catch(() => {});
        this.put({ media: { ...m, playing: !m.playing } });
        return true;
      }
      case "download": {
        const d = this.data.download;
        if (!d) return false;
        this.put({ download: null });
        Bridge.downloadToShelf(d.item.path).then(() => Sound.play("pop"), () => Sound.play("error"));
        return true;
      }
      case "devservers": {
        const first = this.data.devservers[0];
        if (!first) return false;
        Bridge.devserverOpen(first.port).catch(() => {});
        return true;
      }
      default:
        return false;
    }
  }

  private refresh() {
    if (this.mode === "compact") this.render(Date.now());
    this.renderTuck(Date.now());
    this.schedule();
  }

  private tuckInput(): TuckInput {
    const right = this.enabledRight();
    return {
      reminders: this.reminders,
      meeting: this.data.meeting,
      downloadUntil: this.data.download?.until ?? null,
      remindersOn: this.leftEnabled(),
      meetingOn: right.includes("meeting"),
      downloadOn: right.includes("download"),
    };
  }

  /** The tucked pill: a live countdown in Mochi's place while a timer runs, a glow when something waits. */
  private renderTuck(now: number) {
    const tucked = this.mode === "hidden";
    const f = this.data.focus;
    const timer = tucked && f.phase !== "off" && f.endsAt > now
      && !(State.settings.disabledFeatures ?? []).includes("timer");
    const alert = tucked ? tuckAlert(this.tuckInput(), now) : null;

    this.tuckEl.classList.toggle("timer", timer);
    this.tuckEl.classList.toggle("break", timer && f.phase === "break");
    let text = "";
    if (timer) {
      text = tuckTime(f.endsAt - now);
      // The ring empties as the phase runs out (one repaint a second).
      this.tuckArc.style.strokeDashoffset = (100 * (1 - tuckProgress(f, now))).toFixed(2);
    }
    const textChanged = this.tuckTimeEl.textContent !== text;
    if (textChanged) this.tuckTimeEl.textContent = text;
    // The class is only set when the kind changes, so the glow's few pulses
    // play once per new alert rather than on every tick.
    const kind = alert ?? "";
    const kindChanged = this.tuckIconKind !== kind;
    if (kindChanged) {
      this.tuckIconKind = kind;
      if (alert) this.tuckEl.dataset.alert = alert;
      else delete this.tuckEl.dataset.alert;
      const icon = alert === "reminder" ? ICONS.bell : alert === "meeting" ? ICONS.calendar : alert === "download" ? ICONS.download : null;
      this.tuckIcon.replaceChildren(...(icon ? [svg(icon, 11, { stroke: 2 })] : []));
    }
    if (!tucked) return;
    if (!textChanged && !kindChanged && timer === (this.tuckShape.botCx == null)) return;

    // Measure the row (it lays out at its own width whatever the island's) and
    // size the pill to it: Mochi alone, Mochi and an icon, or the timer.
    const rowW = this.tuckRow.offsetWidth;
    const w = Math.min(TUCK_MAX_W, Math.max(TUCK_W, Math.ceil(rowW)));
    const botCx = timer ? null : (w - rowW) / 2 + this.tuckBot.offsetLeft + this.tuckBot.offsetWidth / 2;
    const prev = this.tuckShape;
    if (Math.abs(prev.w - w) < 0.5 && (prev.botCx == null) === (botCx == null)
      && (botCx == null || Math.abs((prev.botCx ?? 0) - botCx) < 0.5)) return;
    this.tuckShape = { w, botCx };
    this.host.tuckChanged(this.tuckShape);
  }

  private render(now: number) {
    // Left
    const pick = this.leftEnabled() ? pickLeft(this.reminders, now) : null;
    this.leftShown = pick;
    const lText = pick ? leftText(pick, now) : "";
    let resized = false;
    if (this.leftText.textContent !== lText) {
      this.leftText.textContent = lText;
      this.leftEl.title = pick?.reminder.text ?? "";
      resized = true;
    }
    this.leftEl.classList.toggle("on", pick != null);
    this.leftEl.classList.toggle("fired", pick?.fired === true);

    // Right
    if (this.data.download && this.data.download.until <= now) this.data.download = null;
    this.items = rightItems(this.enabledRight(), State.settings.disabledFeatures ?? [], this.data, now);
    let id = this.shownId;
    if (!this.items.some((i) => i.id === id)) id = this.items[0]?.id ?? null;
    else if (now >= this.rotateAt && !this.hovered && this.items.length > 1) id = nextItem(this.items, id);
    if (id !== this.shownId) this.rotateAt = now + this.rotateMs();
    const item = this.items.find((i) => i.id === id) ?? null;
    if (this.showRight(item, id !== this.shownId)) resized = true;
    this.shownId = id;

    // Far right: a light per device in use, stacked (microphone over camera).
    const p = this.privacyOn() ? this.data.privacy : null;
    const mic = p?.mic ?? [];
    const cam = p?.camera ?? [];
    this.micEl.classList.toggle("on", mic.length > 0);
    this.camEl.classList.toggle("on", cam.length > 0);
    this.micEl.title = mic.length ? t("Microphone · {app}", { app: mic.join(", ") }) : "";
    this.camEl.title = cam.length ? t("Camera · {app}", { app: cam.join(", ") }) : "";
    const lit = mic.length > 0 || cam.length > 0;
    if (lit !== this.privacyEl.classList.contains("on")) {
      this.privacyEl.classList.toggle("on", lit);
      this.rightEl.classList.toggle("with-privacy", lit);
      resized = true;
    }

    if (resized) this.measure();
  }

  /** Puts `item` on the front layer: in place when it is the same item, with the turn's slide otherwise. */
  private showRight(item: SideItem | null, turn: boolean): boolean {
    const key = item ? `${item.id}|${item.text}|${item.icon ?? ""}|${item.chip ?? ""}|${item.dot ?? ""}` : "";
    const front = this.layers[this.front];
    if (!turn && front.key === key) return false;
    if (!item) {
      front.el.classList.add("gone");
      front.key = "";
      return true;
    }
    if (!turn && front.key) {
      this.fill(front, item, key);
      return true;
    }
    // The old one slides up and out, the new one in from below.
    front.el.classList.add("gone");
    this.front = 1 - this.front;
    const next = this.layers[this.front];
    this.fill(next, item, key);
    next.el.style.transition = "none";
    next.el.classList.remove("gone");
    next.el.classList.add("enter");
    void next.el.offsetWidth; // the start of the slide, once per turn
    next.el.style.transition = "";
    next.el.classList.remove("enter");
    return true;
  }

  private fill(layer: Layer, item: SideItem, key: string) {
    layer.key = key;
    clear(layer.el);
    if (item.dot) layer.el.append(h("span", { class: `ns-dot ${item.dot}` }));
    if (item.icon) layer.el.append(h("span", { class: "ns-icon" }, svg(ICONS[item.icon], 11, { stroke: item.stroke })));
    layer.el.append(h("span", { class: "ns-text", text: item.text }));
    if (item.chip) layer.el.append(h("span", { class: "ns-chip", text: item.chip }));
    layer.el.title = item.text;
    layer.el.classList.toggle("clickable", item.id !== "glance" && item.id !== "privacy");
  }

  /** The two sides' widths, read once per change of text. */
  private measure() {
    const left = this.leftShown ? Math.min(COMPACT_SIDE_MAX, this.leftContent.offsetWidth) : 0;
    const front = this.layers[this.front];
    const lights = this.privacyEl.classList.contains("on") ? PRIVACY_W : 0;
    const right = Math.min(COMPACT_SIDE_MAX, (front.key ? front.el.offsetWidth : 0) + lights);
    if (Math.abs(left - this.widths.left) < 2 && Math.abs(right - this.widths.right) < 2) return;
    this.widths = { left, right };
    this.host.sidesResized(left, right);
  }

  /** The one timer: the next moment something on screen changes by itself. */
  private schedule() {
    if (this.timer != null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    const now = Date.now();
    const waits: number[] = [];
    if (this.mode === "hidden") {
      // Tucked: the countdown's next second, and the moments the glow comes or goes.
      if (this.tuckShape.botCx == null) waits.push(((this.data.focus.endsAt - now) % 1000) || 1000);
      const alertIn = tuckAlertChangeIn(this.tuckInput(), now);
      if (alertIn != null) waits.push(alertIn);
    }
    if (this.mode !== "compact") {
      if (waits.length === 0) return;
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.refresh();
      }, Math.min(...waits, DAY) + 15);
      return;
    }
    const pick = this.leftShown;
    if (pick && !pick.fired) waits.push(countdownChangeIn(pick.reminder.due - now) || 1000);
    const shown = this.items.find((i) => i.id === this.shownId);
    if (shown?.changeIn != null) waits.push(Math.max(250, shown.changeIn));
    if (this.items.length > 1 && !this.hovered) waits.push(Math.max(250, this.rotateAt - now));
    if (waits.length === 0) return;
    const wait = Math.min(...waits, DAY);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, wait + 15);
  }
}
