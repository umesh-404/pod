// The island: DOM shell, sizing animation, Mochi placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI, onDragDrop, onEvent, type DragDropPayload } from "../core/bridge";
import {
  COMPACT_W, EXPANDED_CORNER, EXPANDED_W, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, TUCK_RADIUS, TUCK_W, type TuckShape, botGlowColor, botGlowOpacity, botPosition,
  compactWidth, dropTargetsGeometry, dropZoneAt, islandSize,
  type BotEmoteName, type DropZone, type IslandMode, type IslandShape, type IslandViewName,
} from "../core/layout";
import { SOUND_NAMES, Sound } from "../core/sound";
import { State } from "../core/state";
import { BotEngine, hexToRGB } from "../mochi/engine";
import { Greeting } from "../mochi/greeting";
import { SeasonCache, parseOutfit } from "../mochi/wardrobe";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { IslandStateMachine } from "./fsm";
import { DesktopLink } from "./desktop";
import { DRAG_THRESHOLD } from "../mochi/desktop-logic";
import { Updates } from "./update";
import { FileActions, baseName, chooseDropTiles, fileKindOfMime, fileKindOfName, type FileKind } from "./file-actions";
import { NotchSides } from "./notch";
import { IslandTabs, TAB_INTENT_EVENT } from "./tabs";
import type { TabId } from "../views/tabs/tab";
import { UPDATE_BLUE, showsUpdateHint } from "../whats-new/whats-new";

const BOT_OVERHANG = 40;
const UPDATE_BLUE_RGB = hexToRGB(UPDATE_BLUE);

/** The island's open spring (s) and close curve (ms): quick, with a whisper of overshoot. */
const OPEN_RESPONSE = 0.34;
const OPEN_DAMPING = 0.8;
const CLOSE_MS = 230;
/** Mochi's own spring, quicker than the island's edge. */
const BOT_RESPONSE = 0.24;

/** Frame interval while tucked (≈15 fps). */
const TUCKED_FRAME_MS = 66;

/** Why the open island must not fold on its own: each one holds it open until released. */
type Hold = "drag" | "file" | `tab:${string}`;
/** Extra canvas on each side of Mochi, for the witch hat's brim and the Santa hat's tip. */
const BOT_SIDE = 24;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** A tab's sound by name: the app's own sounds, plus a few plain words for them. */
export function tabSound(name: string): string {
  const aliases: Record<string, string> = { success: "approve", done: "approve", fail: "error", click: "blip", open: "pop" };
  const sound = aliases[name] ?? name;
  return (SOUND_NAMES as readonly string[]).includes(sound) ? sound : "blip";
}

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = Object.assign(new IslandStateMachine(), { stayCompact: true });
  /** Mochi on the desktop: his life cycle and the drag out of the island. */
  readonly desktop: DesktopLink;

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private clockEl!: HTMLElement;
  private clockTimer?: number;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  // Mochi springs ahead of the island's edge, so he is already in his slot by
  // the tabs when they fade in instead of sliding across them.
  private botCx = new Spring(46, BOT_RESPONSE, 0.86);
  private botCy = new Spring(16, BOT_RESPONSE, 0.86);
  private botSize = new Spring(10, BOT_RESPONSE, 0.86);

  private engine = new BotEngine();
  private greeting = new Greeting();
  private greetingShown = false;
  private seasons = new SeasonCache();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;
  /** The pixel ratio Mochi's bitmap was sized for: it changes with the monitor. */
  private canvasDpr = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** What keeps the open island from folding: a file dragged over it, a
   *  conversion being picked or running. */
  private holds = new Set<Hold>();
  /** Where the island was when a file drag came in: a drag that leaves goes back there. */
  private dragReturn: { mode: IslandMode; view: IslandViewName } | null = null;
  /** Moving into the workspace and converting, after a drop (island/file-actions.ts). */
  private fileActions: FileActions;
  /** The compact notch's left and right sides (island/notch.ts). */
  private notch: NotchSides;
  /** Shelf, Reminders, Notes, Tools in the open island (island/tabs.ts). */
  private tabs!: IslandTabs;
  /** The compact island's width for its sides (compactWidth). */
  private compactW = COMPACT_W;
  /** What the current drag holds, as far as the drag tells (null: not read yet). */
  private dragKinds: FileKind[] | null = null;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";

  /** The launch greeting ended: what's new may open (whats-new/controller.ts). */
  onGreetingDone: (() => void) | null = null;

  /** Where a press on Mochi started: moving past DRAG_THRESHOLD drags him out. */
  private botPress: { x: number; y: number } | null = null;

  /** The next reveal from hidden makes no peek (music starting, as on macOS). */
  private silentReveal = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.desktop = new DesktopLink({
      reveal: () => this.reveal(),
      wardrobeFromDesktop: () => this.wardrobeFromDesktop(),
      dizzyFromDesktop: () => this.handleDizzy(),
    });
    this.fileActions = new FileActions({
      show: () => this.openOn("fileAction"),
      hold: (on) => this.setHold("file", on),
      finish: () => this.collapse(),
      celebrate: () => {
        Sound.play("approve");
        this.engine.triggerEmote("happy");
        this.ensureRunning();
      },
      failed: () => Sound.play("error"),
    });
    this.notch = new NotchSides({
      openTab: (id) => this.openTab(id),
      showJob: () => this.openOn("fileAction"),
      reveal: () => this.reveal(),
      sidesResized: (left, right) => this.sidesResized(left, right),
      tuckChanged: (shape) => {
        const shrinking = shape.w < this.tuck.w;
        this.tuck = shape;
        if (State.mode === "hidden") this.animateGeometry(shrinking);
        this.dirty = true;
        this.ensureRunning();
      },
    });
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => {
      this.fsm.greetComplete();
      this.onGreetingDone?.();
    };
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      setTab: (id) => this.openTab(id),
      collapse: () => this.collapse(),
      openWorkspace: () => void Bridge.workspaceOpen(),
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      blip: () => Sound.play("blip"),
      chooseOutfit: (selection) => {
        if (parseOutfit(State.settings.mochiOutfit) === selection) return;
        State.settings.mochiOutfit = selection;
        void Bridge.saveSettings(State.settings);
        Sound.play("pop");
        this.engine.triggerEmote("proud");
        State.notify();
      },
      previewOutfit: (outfit) => {
        State.wardrobePreview = outfit;
        State.notify();
      },
      fileCard: {
        pick: (format) => {
          Sound.play("blip");
          void this.fileActions.pick(format);
        },
        resize: (preset) => {
          Sound.play("blip");
          this.fileActions.resize(preset);
        },
        downloadFfmpeg: () => void this.fileActions.downloadFfmpeg(),
        cancel: () => this.fileActions.cancel(),
        close: () => this.fileActions.close(),
        openWorkspace: () => this.fileActions.openWorkspace(),
        revealOutput: () => this.fileActions.revealOutput(),
      },
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.clockEl = h("div", { id: "island-clock" });
    this.countdown = h("div", { id: "countdown" });

    this.header = buildHeader(actions);
    this.views = buildViews(actions);
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    // The tabs live in the overview view, over its card (which they replace).
    this.tabs = new IslandTabs({
      hold: (id, on) => this.setHold(`tab:${id}`, on),
      resized: (id) => this.tabResized(id),
      close: () => this.collapse(),
      sound: (name) => Sound.play(tabSound(name)),
      takeKeyboard: () => this.takeKeyboard(),
    });
    this.views.get("overview")?.el.append(this.tabs.el);

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.contentEl,
      this.notch.leftEl,
      this.notch.rightEl,
      this.notch.privacyEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.notch.tuckEl,
      this.clockEl,
      this.countdown,
    );

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.openOnHover = State.settings.openOnHover;
    this.fsm.onTransition = (from, to) => {
      // The greeting is over, however it ended: back to his desktop spot.
      if (from === "pod" && to !== "pod") this.desktop.launch();
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "pod") this.greeting.interrupt();
          else if (from === "hidden" && !this.silentReveal) Sound.play("peek");
          this.setMode("compact");
          if (from === "pod") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(this.openingView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "pod":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
    };
  }

  launch() {
    this.fsm.launch();
    void Bridge.notchCovered().then((c) => this.setCovered(c === true));
    void onEvent<boolean>("notch-covered", (c) => this.setCovered(c === true));
  }

  /**
   * The active window reaches under the notch (maximized, full screen, snapped to
   * the top): the compact notch tucks into the wake strip's slim lip so it stays
   * off the window's tabs and title bar. Hovering the lip or dragging a file onto
   * it brings everything back; leaving tucks it again. Uncovered, the compact
   * notch stays on screen as usual.
   */
  private covered = false;
  private setCovered(covered: boolean) {
    if (covered === this.covered) return;
    this.covered = covered;
    this.fsm.stayCompact = !covered;
    this.fsm.petitToHiddenDelay = covered ? 0.8 : 60;
    if (covered) {
      if (this.fsm.state === "petit" && !this.wasInIsland && !this.pinnedNow()) this.fsm.forceHidden();
    } else if (this.fsm.state === "hidden") {
      this.revealSilently();
    }
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") this.engine.resetMorph();
    // First: coming up compact, the sides measure themselves and set its width.
    this.notch.setMode(mode);
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  expand(view: IslandViewName) {
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    State.notify();
  }

  setView(view: IslandViewName) {
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const before = this.targetSize().h;
    State.view = view;
    const grew = this.targetSize().h >= before;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  /**
   * Opens a tab (header button, a click on a notch side, a shortcut), from any
   * state. `intent` tells the tab why (TAB_INTENT_EVENT in island/tabs.ts).
   */
  openTab(id: TabId, intent?: string) {
    if (State.paused) return;
    if (!this.tabs.select(id)) {
      Sound.play("error");
      return;
    }
    if (State.mode === "expanded" && State.view === "overview") {
      const before = this.height.value;
      this.syncTabs();
      const grew = this.targetSize().h >= before;
      State.lastActivity = performance.now();
      this.animateGeometry(!grew);
      State.notify();
    } else {
      this.alert("overview");
      this.syncTabs();
    }
    if (intent) {
      window.dispatchEvent(new CustomEvent(TAB_INTENT_EVENT, { detail: { tab: id, intent } }));
    }
  }

  /** Shows the current tab while the overview is open, hides it otherwise. */
  private syncTabs() {
    const open = State.mode === "expanded" && State.view === "overview" && !State.fileDragOver;
    this.tabs.sync(open);
  }

  /** A tab's content changed height: spring to it if it is the one on screen. */
  private tabResized(id: TabId) {
    if (State.mode !== "expanded" || State.view !== "overview" || State.tab !== id) return;
    const h = this.targetSize().h;
    if (Math.abs(h - this.height.value) < 0.5 && !this.height.animating) return;
    this.animateGeometry(h < this.height.value);
  }

  /** The notch's sides changed width: the compact island springs to fit. */
  /** The tucked pill's size, from what it shows (NotchSides.tuckShape). */
  private tuck: TuckShape = { w: TUCK_W, botCx: TUCK_W / 2 };

  private sidesResized(left: number, right: number) {
    const w = compactWidth(left, right);
    if (w === this.compactW) return;
    const shrinking = w < this.compactW;
    this.compactW = w;
    if (State.mode === "compact") this.animateGeometry(shrinking);
  }

  collapse() {
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  /** Opens on this view (tray, shortcuts, update). Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  /**
   * Opens on a view while something holds the island open: like alert(), but
   * the holds keep it pinned rather than the user's Ctrl+P alone.
   */
  private openOn(view: IslandViewName) {
    this.fsm.pinned = this.pinnedNow();
    if (State.mode === "expanded" && State.view === view) return;
    this.fsm.forceHome();
    this.expand(view);
  }

  /** Pinned by the user or by a hold. */
  private pinnedNow(): boolean {
    return State.isPinned || this.holds.size > 0;
  }

  private setHold(reason: Hold, on: boolean) {
    if (this.holds.has(reason) === on) return;
    if (on) this.holds.add(reason);
    else this.holds.delete(reason);
    if (on) {
      this.fsm.pinned = true;
      this.fsm.cancelTimers();
      return;
    }
    this.fsm.pinned = this.pinnedNow();
    // The countdown the hold kept back starts now, if the pointer is elsewhere.
    if (!this.fsm.pinned && !this.wasInIsland && this.fsm.state === "home") this.fsm.mouseLeft();
  }

  /** A new Pod waits and Mochi has nothing else to say (he is blue). */
  private updateHintOn(): boolean {
    return !State.paused && showsUpdateHint(Updates.waiting(), State.effectiveState, false);
  }

  /**
   * What a click or a hover opens on: while Mochi is blue, the new version
   * ("Pod X is out", Update now); otherwise the usual view.
   */
  private openingView(): IslandViewName {
    return this.updateHintOn() ? "update" : State.defaultView();
  }

  reveal() {
    this.fsm.reveal();
  }

  /** Music started playing: the compact island, without the peek sound (musicReveal). */
  revealSilently() {
    this.silentReveal = true;
    this.fsm.reveal();
    this.silentReveal = false;
  }

  /** Right-click on Mochi: wardrobe open ↔ back to the usual view. */
  toggleWardrobe() {
    if (State.paused || State.mode === "hidden") return;
    // The greeting and the drop sequence draw a Mochi of their own.
    if (State.mode === "expanded" && State.view === "greeting") return;
    if (State.mode === "expanded" && State.view === "wardrobe") this.setView(State.defaultView());
    else this.setView("wardrobe");
  }

  /**
   * Right-click on the desktop Mochi (macOS openWardrobeFromDesktop): opens the
   * wardrobe from any state, or goes back if it is already open.
   */
  wardrobeFromDesktop() {
    this.wardrobeAnywhere();
  }

  /**
   * The wardrobe from any state — compact or hidden island included — or back
   * to the usual view if it is already open. The desktop Mochi's right-click
   * and the wardrobe shortcut (`open-wardrobe`) both land here.
   */
  wardrobeAnywhere() {
    if (State.mode === "expanded" && State.view === "wardrobe") {
      this.setView(State.defaultView());
      return;
    }
    if (State.paused) return;
    this.alert("wardrobe");
  }

  // ── Keyboard shortcuts (island/shortcuts.ts) ────────────────────────────────

  emote(name: BotEmoteName) {
    this.engine.triggerEmote(name);
    this.ensureRunning();
  }

  /** Ctrl+P: keep the open island from folding away, or let it fold again. */
  setPinned(on: boolean) {
    State.isPinned = on;
    this.fsm.pinned = on;
    if (on) {
      // The countdown bar reads the state machine's deadline, cleared with it.
      this.fsm.cancelTimers();
    } else if (!this.wasInIsland && this.fsm.state === "home") {
      this.fsm.mouseLeft();
    }
    State.notify();
  }

  /** The island takes the keyboard, so its own shortcuts work (Mac: makeKey).
   *  It gives it back when it closes. */
  takeKeyboard() {
    void Bridge.focusWindow(true);
  }

  /** The desktop shortcut needs a desktop Mochi: none on GNOME's Wayland. */
  canLeaveIsland(): boolean {
    return this.desktop.supported;
  }

  /** The desktop shortcut (macOS DesktopMochiController.flyOutOrHome). */
  flyOutOrHome() {
    // The greeting draws a Mochi of its own: he stays for it, as he does for
    // a drag (canDragOut).
    const busy = State.mode === "expanded" && State.view === "greeting";
    if (busy && !State.mochiOnDesktop) return;
    this.desktop.flyOutOrHome();
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  /**
   * Files dragged over the island: it grows a little into the two drop tiles,
   * Mochi a box between them. The tile on the pointer's side of the island's
   * middle lights up; the drop goes to that one (island/file-actions.ts).
   */
  private onDragDrop(e: DragDropPayload) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        // The drag's own position: no mouse events reach the page during a drag.
        if (e.x != null && e.y != null) this.onCursor(e.x, e.y);
        if (!State.fileDragOver) {
          // The tiles that fit what is dragged: the names where the drag gives
          // them (Linux), else the MIME types WebView2 shows during the drag.
          const kinds = e.paths?.length ? e.paths.map(fileKindOfName) : (this.dragKinds ?? []);
          const tiles = chooseDropTiles(kinds, State.settings.disabledFeatures ?? []);
          if (tiles.length === 0) return;
          State.dropTiles = tiles;
          State.dropZone = null;
        }
        this.updateDropZone(e.x, e.y);
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.dragReturn = { mode: State.mode, view: State.view };
        this.engine.animateMorph(1);
        this.refreshWorkspaceName();
        this.setHold("drag", true);
        this.openOn("dropTargets");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        this.endDrag();
        this.foldBackAfterDrag();
        break;
      }
      case "drop": {
        // On Windows the paths come in a second event, after the page's drop:
        // the tile is the one that was lit when the files were let go.
        const zone = State.dropZone ?? (e.x != null && e.y != null ? this.dropZoneFor(e.x, e.y) : null);
        this.endDrag();
        if (this.fileActions.drop(zone, e.paths ?? [])) {
          this.dragReturn = null;
          return;
        }
        this.foldBackAfterDrag();
        break;
      }
    }
  }

  /** The tile under a window point, against the island's final drop-targets
   *  shape (it may still be growing into it). */
  private dropZoneFor(x: number, y: number): DropZone | null {
    const viewportW = window.innerWidth > 0 ? window.innerWidth : PANEL_W;
    const w = dropTargetsGeometry(State.dropTiles.length).w;
    return dropZoneAt(x - (viewportW - w) / 2, y, State.dropTiles);
  }

  /**
   * What is dragged, read from the page's own drag events before the bridge
   * hears of them (capture phase): during a drag WebView2 shows each item's
   * MIME type but not its name.
   */
  private readDragKinds() {
    const read = (e: DragEvent) => {
      const items = e.dataTransfer?.items;
      if (!items || items.length === 0) return null;
      // A file dragged out of a web page with no type of its own comes with
      // the page's link or HTML: in practice, a picture.
      const types = e.dataTransfer?.types ?? [];
      const fromPage = types.includes("text/uri-list") || types.includes("text/html");
      const kinds: FileKind[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind !== "file") continue;
        kinds.push(items[i].type ? fileKindOfMime(items[i].type) : fromPage ? "image" : "other");
      }
      return kinds;
    };
    window.addEventListener("dragenter", (e) => {
      if (!State.fileDragOver) this.dragKinds = read(e);
    }, true);
    window.addEventListener("dragover", (e) => {
      if (this.dragKinds == null && !State.fileDragOver) this.dragKinds = read(e);
    }, true);
  }

  /** Dragover fires constantly: State only hears of a change of tile. */
  private updateDropZone(x: number | undefined, y: number | undefined) {
    const zone = this.dropZoneFor(x ?? State.mouse.x, y ?? State.mouse.y);
    if (zone === State.dropZone) return;
    State.dropZone = zone;
    State.notify();
  }

  /** The workspace folder's name for its tile, asked as each drag starts. */
  private refreshWorkspaceName() {
    void Bridge.workspaceInfo().then((info) => {
      if (!info?.dir) return;
      const name = baseName(info.dir);
      if (name === State.workspaceName) return;
      State.workspaceName = name;
      State.notify();
    });
  }

  private endDrag() {
    this.dragKinds = null;
    State.fileDragOver = false;
    State.dropZone = null;
    this.engine.animateMorph(0);
    this.setHold("drag", false);
    State.notify();
  }

  /** The drag left, or dropped nothing: back to where the island was. */
  private foldBackAfterDrag() {
    const back = this.dragReturn;
    this.dragReturn = null;
    // Something else (an alert) took the island over meanwhile: it stays.
    if (State.mode !== "expanded" || State.view !== "dropTargets") return;
    if (back?.mode === "expanded" && back.view !== "dropTargets") this.setView(back.view);
    else if (back?.mode === "expanded") this.setView(State.defaultView());
    else this.collapse();
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  /** What sizes the island beyond mode and view: drop tiles, the tab's height, the sides. */
  private shape(): IslandShape {
    const tabsH = State.mode === "expanded" && State.view === "overview" && this.tabs.any
      ? this.tabs.islandHeight()
      : null;
    return { dropCount: State.dropTiles.length, tabsH, compactW: this.compactW, tuck: this.tuck };
  }

  /** The shape the island last animated to: Mochi's place reads it every frame. */
  private botShape: IslandShape | undefined;

  private targetSize(): { w: number; h: number; r: number } {
    const shape = this.shape();
    this.botShape = shape;
    const { w, h } = islandSize(State.mode, State.view, shape);
    const r = State.mode === "expanded" ? EXPANDED_CORNER : State.mode === "hidden" ? TUCK_RADIUS : ROUNDED_CORNER;
    return { w, h, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w, CLOSE_MS);
      this.height.curveTowards(h, CLOSE_MS);
      this.radius.curveTowards(r, CLOSE_MS);
    } else {
      this.width.springTo(w, OPEN_RESPONSE, OPEN_DAMPING);
      this.height.springTo(h, OPEN_RESPONSE, OPEN_DAMPING);
      this.radius.springTo(r, OPEN_RESPONSE, OPEN_DAMPING);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    this.islandEl.style.transform = `translateX(-50%)`;
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    this.clockEl.style.height = `${hh}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;

    const viewportW = window.innerWidth > 0 ? window.innerWidth : PANEL_W;
    const rect = { x: (viewportW - w) / 2, y: 0, w, h: hh };
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Island rect in window coordinates (origin top-left of the 720×320 window). */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    const viewportW = window.innerWidth > 0 ? window.innerWidth : PANEL_W;
    return { x: (viewportW - w) / 2, y: 0, w, h: hh };
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip:
      // from there the OS delivers no cursor events, so nothing polls at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      void Bridge.setCollapsed(false);
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden.
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      if (State.mode !== "hidden") return;
      // The pointer is on the tucked pill: the island it opens into must see it
      // there, or it folds straight back (the cursor poll takes over from here).
      this.wasInIsland = true;
      this.notch.setHovered(true);
      this.fsm.mouseEntered();
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      // A click makes a hover-opened island an ordinary open one.
      this.fsm.userInteracted();
      // A press on Mochi may become a drag out to the desktop.
      if (e.button === 0 && this.isBotHit(e.clientX, e.clientY)) {
        this.botPress = { x: e.clientX, y: e.clientY };
      }
      // Right-click on Mochi opens the wardrobe, and closes it again.
      if (e.button === 2 && this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.toggleWardrobe();
        return;
      }
      if (State.mode !== "expanded") {
        this.fsm.click();
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    // No browser menu over Mochi: his right-click is the wardrobe. Everywhere
    // else (the chat field) the webview keeps its own menu.
    this.islandEl.addEventListener("contextmenu", (e) => {
      if (this.isBotHit(e.clientX, e.clientY)) e.preventDefault();
    });

    // Dragging Mochi out of the island puts him on the desktop.
    window.addEventListener("mousemove", (e) => {
      if (this.desktop.carrying) {
        this.desktop.carry(e.clientX, e.clientY);
        return;
      }
      const press = this.botPress;
      if (!press) return;
      if (!(e.buttons & 1)) {
        this.botPress = null;
        return;
      }
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= DRAG_THRESHOLD) return;
      this.botPress = null;
      if (!this.canDragOut()) return;
      this.cancelBotHover();
      this.desktop.pickUp(e.clientX, e.clientY);
    });
    window.addEventListener("mouseup", (e) => {
      this.botPress = null;
      if (this.desktop.carrying) this.desktop.carryEnd(e.clientX, e.clientY);
    });

    // Only keys typed into the island itself land here, never Escape typed in
    // another app.
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && State.mode === "expanded" && !State.isPinned) this.collapse();
      State.lastActivity = performance.now();
    });

    this.readDragKinds();
    void onDragDrop((e) => this.onDragDrop(e));

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) {
      this.followPageCursor();
      this.followPageDrags();
    }
  }

  /**
   * Outside Tauri (`npm run dev`) the bridge sends no drag events: the page's
   * own drag events stand in for them, file names in place of paths, so the
   * drop tiles and the cards that follow can be inspected in a browser.
   */
  private followPageDrags() {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
    window.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (depth++ === 0) this.onDragDrop({ type: "enter", x: e.clientX, y: e.clientY });
    });
    window.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.onDragDrop({ type: "over", x: e.clientX, y: e.clientY });
    });
    window.addEventListener("dragleave", (e) => {
      if (!hasFiles(e) || depth === 0) return;
      if (--depth === 0) this.onDragDrop({ type: "leave" });
    });
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      depth = 0;
      const paths = [...(e.dataTransfer?.files ?? [])].map((f) => f.name);
      this.onDragDrop({ type: "drop", paths, x: e.clientX, y: e.clientY });
    });
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland): the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /**
   * Pointer on/off the island as the compositor sees it (Linux only). Null
   * until the first report, so a platform that never sends it is not gated.
   */
  private pointerInside: boolean | null = null;

  setPointerInside(inside: boolean) {
    this.pointerInside = inside;
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    // WebKitGTK can deliver a mousemove after the pointer has left the layer
    // surface; trusting it re-enters the island and the auto-close never runs.
    if (this.pointerInside === false) {
      x = -10_000;
      y = -10_000;
    }
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    // Recorded before the state machine hears of it: a transition it makes
    // right away (open on hover) reads where the pointer is, and must not see
    // the pointer as still outside.
    const wasIn = this.wasInIsland;
    this.wasInIsland = inIsland;
    // The right side's turn waits while the pointer is on the island.
    if (inIsland !== wasIn) this.notch.setHovered(inIsland);
    if (inIsland && !wasIn) {
      if (this.fsm.state === "pod") this.greeting.hover();
      this.fsm.mouseEntered();
    }
    if (!inIsland && wasIn) {
      this.fsm.mouseLeft();
    }

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  /** The greeting draws a Mochi of its own: not that one. */
  private canDragOut(): boolean {
    if (State.mode === "hidden" || !this.desktop.canPickUp()) return false;
    return !(State.mode === "expanded" && State.view === "greeting");
  }

  private isBotHit(x: number, y: number): boolean {
    // Out on the desktop, the island's Mochi is invisible: nothing to hit.
    if (State.mochiOnDesktop) return false;
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (this.greetingCanvas.width !== Math.round(EXPANDED_W * dpr)) {
          this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
          this.greetingCanvas.height = Math.round(150 * dpr);
        }
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      this.drawBot(dt);
    }

    const viewAnimating = this.views.get(State.view)?.tick?.(nowMs) === true;
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — breathing, ratelimit sweat, sleeping z's, the search
    // sweep — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating;
    // Tucked, Mochi stays alive in his pill at a quarter of the frame rate: at
    // 13 px nobody sees more, and the loop costs a quarter as much.
    const tucked = State.mode === "hidden" && !settling;
    const busy = State.mode === "hidden"
      ? settling || (this.engine.busy && this.tuck.botCx != null)
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.busy || viewAnimating;

    if (busy) {
      if (tucked) window.setTimeout(() => requestAnimationFrame(this.frame), TUCKED_FRAME_MS);
      else requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value, this.botShape);
    // Compact: Mochi stays in the middle while the island grows around him.
    if (State.mode === "compact") p.cx = this.width.value / 2;
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // Out on the desktop, he isn't here at all.
    const away = State.mochiOnDesktop;
    const visible = p.opacity > 0 && !greetingActive && !away;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    if (State.mode === "expanded" && !greetingActive && !away) {
      const d = p.diameter;
      const color = botGlowColor(State.effectiveState);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(botGlowOpacity(State.effectiveState));
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const wCss = w + BOT_SIDE * 2;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Drawn at the current ratio, so a bitmap sized for another monitor's
    // would show Mochi too big and cut, or too small.
    if (this.canvasPx !== w || this.canvasDpr !== dpr) {
      this.canvasPx = w;
      this.canvasDpr = dpr;
      this.botCanvas.width = Math.round(wCss * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${wCss}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - wCss / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    // A new Pod waits: over an idle or sleeping Mochi, the blue and the arrow
    // badge (whats-new.ts). Anything Mochi has to say comes first.
    this.engine.setUpdateHint(this.updateHintOn() ? UPDATE_BLUE_RGB : null);
    this.engine.bodyColor = this.engine.showsUpdateHint ? UPDATE_BLUE_RGB : null;
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    // In the wardrobe the hovered outfit swaps in at once, without the drop-in.
    const inWardrobe = State.mode === "expanded" && State.view === "wardrobe";
    const outfit = State.wardrobePreview ?? this.seasons.get(parseOutfit(State.settings.mochiOutfit));
    this.engine.setOutfit(outfit, !inWardrobe);

    this.engine.update(dt);
    // Cleared in device pixels, the whole canvas. At a fractional scale (150 %)
    // the canvas is a whole number of pixels but `hCss * dpr` is not: clearing
    // in CSS units left the last row half-cleared, and whatever once passed
    // through it (a hat in a roll) piled up there into a coloured bar.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.botCanvas.width, this.botCanvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, BOT_SIDE * dpr, 0);
    ctx.save();
    this.engine.applyDance(ctx, w, hCss);
    this.engine.draw(ctx, w, hCss);
    ctx.restore();
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  private updateCountdown(nowMs: number) {
    // The state machine's own deadline, so the bar follows an auto-close delay
    // edited while the countdown runs.
    const dueAt = this.fsm.homeCollapseDueAt;
    if (State.mode !== "expanded" || State.isPinned || dueAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = this.fsm.homeToPetitDelay;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (dueAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    const live = expanded && !greetingActive;
    // Paused CSS animations (the drop tiles' marching dashes) unless the island is open.
    this.islandEl.classList.toggle("expanded", expanded);
    this.contentEl.style.opacity = live ? "1" : "0";
    this.contentEl.style.pointerEvents = live ? "auto" : "none";
    this.header.el.style.pointerEvents = live ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    // Leaving the greeting, however it ends, lets its sound fade out.
    if (this.greetingShown && !greetingActive) this.greeting.leave();
    this.greetingShown = greetingActive;
    // A wardrobe try-on never outlives the wardrobe.
    if (State.wardrobePreview && !(expanded && State.view === "wardrobe")) State.wardrobePreview = null;

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }
    // The overview shows the tabs when there are any, its own card otherwise.
    this.views.get("overview")?.el.classList.toggle("has-tabs", this.tabs.any);
    this.syncTabs();
    this.islandEl.classList.toggle("compact", State.mode === "compact");
    this.islandEl.classList.toggle("tucked", State.mode === "hidden");
    this.notch.sync();

    this.updateClock();

    this.engine.setState(State.effectiveState);
  }

  /** The clock sits in the middle of the compact island, where the notch is on a Mac. */
  private updateClock() {
    const on = State.mode === "compact" && State.settings.showClock;
    this.clockEl.style.opacity = on ? "1" : "0";
    if (!on) return;
    const now = new Date();
    const date = now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const text = `${date}  ${time}`;
    if (this.clockEl.textContent !== text) this.clockEl.textContent = text;
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.openOnHover = State.settings.openOnHover;
    const tabsBefore = `${State.tabs.join(",")}|${State.tab}`;
    this.tabs.refresh();
    this.notch.settingsChanged();
    // A tab switched off while it shows: the island takes the next one's size.
    if (`${State.tabs.join(",")}|${State.tab}` !== tabsBefore && State.mode === "expanded") this.animateGeometry(false);
    State.notify();
    // ponytail: one timer for the life of the window; a minute is the clock's finest tick.
    this.clockTimer ??= window.setInterval(() => this.updateClock(), 10_000);
  }

  /** After boot: the notch's sides read what is already there (reminders, shelf). */
  startSides() {
    void this.notch.start();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }
}
