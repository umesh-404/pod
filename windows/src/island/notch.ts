// The compact notch's two sides, around Mochi.
//
// Each side shows the items listed for it in Settings → Notch
// (`settings.leftWidgets`, `settings.rightWidgets`), taking turns every
// `leftRotateSeconds` / `rotateSeconds` (a short crossfade and slide); an item
// with nothing to show is skipped. By default the left holds the reminder
// item — a fired reminder first (pulsing; a click opens the Reminders tab,
// where Done and Snooze are), else the nearest deadline as a countdown
// ("Essay · 2d 4h") — and the right the live items. The camera and microphone
// lights sit at the far right whatever the lists say.
//
// What each item shows, and a side's layers, are in notch-items.ts (shared
// with the Settings window's live preview).
//
// Efficiency: one timer for the whole notch, set for the next moment some text
// on screen changes (a minute step, a second only where a countdown under an
// hour or the focus timer shows seconds, the next turn, a download's expiry)
// and only while the compact island is up. The watchers in Rust (media,
// glance, privacy, downloads, dev servers) run only for the items on either
// side and only while the island is not hidden. Widths are measured once per
// change of text, never per frame.

import {
  Bridge, onEvent,
  type DevServer, type Glance, type InUse, type Meeting, type NewDownload, type NowPlaying, type Reminder, type ShelfItem,
} from "../core/bridge";
import { Focus } from "../core/focus";
import { COMPACT_SIDE_MAX, TUCK_MAX_W, TUCK_W, type IslandMode, type TuckShape } from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import type { TabId } from "../views/tabs/tab";
import { language, t } from "../i18n/i18n";
import { fileActionProgress } from "./file-actions";
import {
  DOWNLOAD_TTL_MS, SideView, featureOf, notchLayout, rotateMsOf, sideItems,
  type NotchData, type NotchSideName, type SideItemId,
} from "./notch-items";
import {
  SOON_MS, tuckAlert, tuckAlertChangeIn, tuckPercent, tuckProgress, tuckShort, tuckShortChangeIn, tuckSoon, tuckTime,
  type TuckInput,
} from "./tuck";

export {
  DOWNLOAD_TTL_MS, RIGHT_ITEM_IDS, SIDE_ITEM_IDS, SideView, countdownChangeIn, countdownText, featureOf, leftText,
  nextItem, notchLayout, pickLeft, rightItems, rotateMsOf, sideItem, sideItems,
  type LeftPick, type NotchData, type RightItemId, type SideItem, type SideItemId,
} from "./notch-items";

const DAY = 24 * 60 * 60_000;

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

/** What has a watcher in Rust: the items backed by one, and the camera and microphone lights. */
type Watched = SideItemId | "privacy";

/** Items backed by a watcher in Rust, turned on only while shown. */
const WATCHERS: Partial<Record<Watched, (on: boolean) => unknown>> = {
  media: (on) => Bridge.mediaWatch(on),
  glance: (on) => Bridge.glanceWatch(on),
  privacy: (on) => Bridge.privacyWatch(on),
  download: (on) => Bridge.downloadsWatch(on),
  devservers: (on) => Bridge.devserversWatch(on),
};

/** Room the stacked camera and microphone lights take at the right end, px. */
const PRIVACY_W = 16;

export class NotchSides {
  private host: NotchHost;
  private left: SideView;
  private right: SideView;
  readonly leftEl: HTMLElement;
  readonly rightEl: HTMLElement;
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
  private tuckEq: HTMLElement;
  private tuckSoonEl: HTMLElement;
  private tuckSoonText: HTMLElement;
  private tuckMic: HTMLElement;
  private tuckCam: HTMLElement;
  /** What the pill's row last laid out, so it is measured only when that changes. */
  private tuckKey = "";
  /** The pill's size and Mochi's place in it, as last reported to the island. */
  tuckShape: TuckShape = { w: TUCK_W, botCx: TUCK_W / 2 };
  private micEl: HTMLElement;
  private camEl: HTMLElement;

  private reminders: Reminder[] = [];
  private data: NotchData = {
    job: null, focus: { phase: "off", endsAt: 0, length: 0 }, meeting: null, media: null, shelfCount: 0,
    glance: null, privacy: null, download: null, devservers: [],
  };

  private mode: IslandMode = "hidden";
  private hovered = false;
  private timer: number | null = null;
  private watching = new Set<Watched>();
  private widths = { left: -1, right: -1 };
  private calendarAsked = false;

  constructor(host: NotchHost) {
    this.host = host;
    this.left = new SideView("left");
    this.right = new SideView("right");
    this.leftEl = this.left.el;
    this.rightEl = this.right.el;
    this.micEl = h("span", { class: "ns-light mic" }, svg(ICONS.mic, 9, { stroke: 2.4 }));
    this.camEl = h("span", { class: "ns-light camera" }, svg(ICONS.camera, 9, { stroke: 2.4 }));
    this.privacyEl = h("div", { class: "ns-privacy" }, this.micEl, this.camEl);
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
    // Music playing: three bars in Mochi's place (CSS keyframes, transform only).
    this.tuckEq = h("span", { class: "tuck-eq" }, h("i"), h("i"), h("i"));
    // A reminder due within the hour: a bell and its countdown ("4m").
    this.tuckSoonText = h("span", { class: "tuck-soon-text" });
    this.tuckSoonEl = h("span", { class: "tuck-soon" }, svg(ICONS.bell, 11, { stroke: 2 }), this.tuckSoonText);
    // Camera and microphone in use: a light each, stacked at the right end.
    this.tuckMic = h("i", { class: "tuck-light mic" });
    this.tuckCam = h("i", { class: "tuck-light camera" });
    const lights = h("span", { class: "tuck-lights" }, this.tuckMic, this.tuckCam);
    this.tuckRow = h(
      "div",
      { class: "tuck-row" },
      this.tuckBot, this.tuckEq, ring, this.tuckTimeEl, this.tuckSoonEl, this.tuckIcon, lights,
    );
    this.tuckEl = h(
      "div",
      { class: "tuck-face", "aria-hidden": "true" },
      h("i", { class: "tuck-glow" }),
      h("div", { class: "tuck-inner" }, h("i", { class: "tuck-shine" }), this.tuckRow),
    );

    // A press on an item does the item's thing rather than opening the island.
    for (const side of [this.left, this.right]) {
      side.el.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || !side.shownId) return;
        if (this.click(side.shownId)) e.stopPropagation();
      });
    }

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
    // Leaving gives the items on screen a full turn again.
    if (!on) {
      const now = Date.now();
      this.left.restartTurn(now, this.rotateMs("left"));
      this.right.restartTurn(now, this.rotateMs("right"));
    }
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
    // A job's progress fills the tucked pill's ring.
    else if (this.mode === "hidden") this.renderTuck(Date.now());
  }

  /** Each side's items switched on, their feature on too. */
  private enabled(): { left: SideItemId[]; right: SideItemId[] } {
    const off = new Set(State.settings.disabledFeatures ?? []);
    const { left, right } = notchLayout(State.settings);
    const on = (id: SideItemId) => !off.has(featureOf(id));
    return { left: left.filter(on), right: right.filter(on) };
  }

  /** The items on either side. */
  private enabledItems(): SideItemId[] {
    const { left, right } = this.enabled();
    return [...left, ...right];
  }

  /** The camera and microphone lights (Settings → Features). */
  private privacyOn(): boolean {
    return !(State.settings.disabledFeatures ?? []).includes("privacy");
  }

  /** Music on the tucked pill: off with the media item's feature. */
  private mediaOn(): boolean {
    return !(State.settings.disabledFeatures ?? []).includes("media");
  }

  /** The Reminders feature: its sound, the reveal, and the tucked pill's bell. */
  private leftEnabled(): boolean {
    return !(State.settings.disabledFeatures ?? []).includes("reminders");
  }

  private rotateMs(side: NotchSideName): number {
    return rotateMsOf(side === "left" ? State.settings.leftRotateSeconds : State.settings.rotateSeconds);
  }

  private applyWatchers() {
    const visible = this.mode !== "hidden";
    const want = new Set<Watched>(visible ? this.enabledItems().filter((id) => WATCHERS[id]) : []);
    // The tucked pill still shows the camera and microphone lights and the
    // music playing, so those two watchers (both event-driven) stay on.
    if (this.privacyOn()) want.add("privacy");
    if (!visible && this.mediaOn()) want.add("media");
    for (const id of Object.keys(WATCHERS) as Watched[]) {
      const on = want.has(id);
      if (on === this.watching.has(id)) continue;
      if (on) this.watching.add(id);
      else this.watching.delete(id);
      void WATCHERS[id]?.(on);
      if (on) this.fetchNow(id);
    }
    // The calendar has no watcher: one look when the meeting item first shows.
    if (visible && !this.calendarAsked && this.enabledItems().includes("meeting") && (State.settings.calendarUrls ?? []).length > 0) {
      this.calendarAsked = true;
      Bridge.calendarRefresh().then((m) => this.put({ meeting: m }), () => {});
    }
  }

  private fetchNow(id: Watched) {
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

  /** A press on an item. True when the item took it. */
  private click(id: SideItemId): boolean {
    Sound.resume();
    switch (id) {
      case "reminder":
        this.host.openTab("reminders");
        return true;
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
    const items = this.enabledItems();
    return {
      reminders: this.reminders,
      meeting: this.data.meeting,
      downloadUntil: this.data.download?.until ?? null,
      remindersOn: this.leftEnabled(),
      meetingOn: items.includes("meeting"),
      downloadOn: items.includes("download"),
    };
  }

  /**
   * The tucked pill, sized to what it shows. One main thing in Mochi's place —
   * a job's progress, else a running timer, else music playing (an equaliser),
   * else Mochi himself — then the alert's icon or else a reminder due within
   * the hour ("🔔 4m"), then the camera and microphone lights. Something
   * waiting also makes it glow.
   */
  private renderTuck(now: number) {
    const tucked = this.mode === "hidden";
    const off = State.settings.disabledFeatures ?? [];
    const f = this.data.focus;
    const job = this.data.job ? fileActionProgress(this.data.job) : null;
    const timer = tucked && job == null && f.phase !== "off" && f.endsAt > now && !off.includes("timer");
    const music = tucked && job == null && !timer && this.mediaOn() && this.data.media?.playing === true;
    const alert = tucked ? tuckAlert(this.tuckInput(), now) : null;
    const soon = tucked && !alert ? tuckSoon(this.reminders, now, this.leftEnabled()) : null;
    const p = tucked && this.privacyOn() ? this.data.privacy : null;
    const mic = (p?.mic.length ?? 0) > 0;
    const cam = (p?.camera.length ?? 0) > 0;

    this.tuckEl.classList.toggle("timer", timer || job != null);
    this.tuckEl.classList.toggle("job", job != null);
    this.tuckEl.classList.toggle("break", timer && f.phase === "break");
    this.tuckEl.classList.toggle("music", music);
    this.tuckEl.classList.toggle("soon", soon != null);
    this.tuckEl.classList.toggle("lights", mic || cam);
    this.tuckMic.classList.toggle("on", mic);
    this.tuckCam.classList.toggle("on", cam);

    let text = "";
    if (job != null) {
      text = tuckPercent(job);
      // The ring fills as the job goes.
      this.tuckArc.style.strokeDashoffset = (100 * (1 - Math.min(1, Math.max(0, job)))).toFixed(2);
    } else if (timer) {
      text = tuckTime(f.endsAt - now);
      // The ring empties as the phase runs out (one repaint a second).
      this.tuckArc.style.strokeDashoffset = (100 * (1 - tuckProgress(f, now))).toFixed(2);
    }
    if (this.tuckTimeEl.textContent !== text) this.tuckTimeEl.textContent = text;
    const soonText = soon ? tuckShort(soon.due - now, language()) : "";
    if (this.tuckSoonText.textContent !== soonText) this.tuckSoonText.textContent = soonText;
    this.tuckSoonEl.title = soon?.text ?? "";

    // The class is only set when the kind changes, so the glow's few pulses
    // play once per new alert rather than on every tick.
    const kind = alert ?? "";
    if (this.tuckIconKind !== kind) {
      this.tuckIconKind = kind;
      if (alert) this.tuckEl.dataset.alert = alert;
      else delete this.tuckEl.dataset.alert;
      const icon = alert === "reminder" ? ICONS.bell : alert === "meeting" ? ICONS.calendar : alert === "download" ? ICONS.download : null;
      this.tuckIcon.replaceChildren(...(icon ? [svg(icon, 12, { stroke: 2 })] : []));
    }
    if (!tucked) return;

    // Measure the row only when what it lays out changed (it lays out at its
    // own width whatever the island's) and size the pill to it.
    const key = [this.tuckEl.className, kind, text.length, soonText].join("|");
    if (key === this.tuckKey) return;
    this.tuckKey = key;
    const rowW = this.tuckRow.offsetWidth;
    const w = Math.min(TUCK_MAX_W, Math.max(TUCK_W, Math.ceil(rowW)));
    const mochi = !timer && job == null && !music;
    const botCx = mochi ? (w - rowW) / 2 + this.tuckBot.offsetLeft + this.tuckBot.offsetWidth / 2 : null;
    const prev = this.tuckShape;
    if (Math.abs(prev.w - w) < 0.5 && (prev.botCx == null) === (botCx == null)
      && (botCx == null || Math.abs((prev.botCx ?? 0) - botCx) < 0.5)) return;
    this.tuckShape = { w, botCx };
    this.host.tuckChanged(this.tuckShape);
  }

  private render(now: number) {
    if (this.data.download && this.data.download.until <= now) this.data.download = null;
    const off = State.settings.disabledFeatures ?? [];
    const lists = this.enabled();
    const data: NotchData = { ...this.data, reminders: this.reminders };
    let resized = this.left.update(sideItems(lists.left, off, data, now), now, this.hovered, this.rotateMs("left"));
    if (this.right.update(sideItems(lists.right, off, data, now), now, this.hovered, this.rotateMs("right"))) resized = true;

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

  /** The two sides' widths, read once per change of text. */
  private measure() {
    const lights = this.privacyEl.classList.contains("on") ? PRIVACY_W : 0;
    const left = Math.min(COMPACT_SIDE_MAX, this.left.width());
    const right = Math.min(COMPACT_SIDE_MAX, this.right.width() + lights);
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
      const f = this.data.focus;
      if (f.phase !== "off" && f.endsAt > now) waits.push(((f.endsAt - now) % 1000) || 1000);
      const soon = tuckSoon(this.reminders, now, this.leftEnabled());
      if (soon) waits.push(tuckShortChangeIn(soon.due - now));
      else {
        // The next reminder to come within the hour starts its countdown then.
        const next = this.reminders.filter((r) => !r.fired && r.due > now).sort((x, y) => x.due - y.due)[0];
        if (next) waits.push(Math.max(1000, next.due - now - SOON_MS + 1));
      }
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
    waits.push(...this.left.waits(now, this.hovered), ...this.right.waits(now, this.hovered));
    if (waits.length === 0) return;
    const wait = Math.min(...waits, DAY);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, wait + 15);
  }
}
