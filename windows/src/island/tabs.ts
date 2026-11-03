// The open island's tabs: Shelf, Reminders, Notes, Tools (src/views/tabs).
// Each tab is built once and mounted in the overview view; the island tells it
// when it is on screen (show) and when it is not (hide: switched away, the
// island folded or another view took over), so a hidden tab runs nothing.
// A tab whose feature is in `disabledFeatures` has no button and never shows.

import { tabsIslandHeight } from "../core/layout";
import { State } from "../core/state";
import type { Tab, TabHost, TabId } from "../views/tabs/tab";
import { shelfTab } from "../views/tabs/shelf";
import { remindersTab } from "../views/tabs/reminders";
import { notesTab } from "../views/tabs/notes";
import { toolsTab } from "../views/tabs/tools";
import { h } from "../views/dom";

/** Header order. The ids are also their `disabledFeatures` ids. */
export const TAB_IDS: readonly TabId[] = ["shelf", "reminders", "notes", "tools"];

const FACTORIES: Record<TabId, (host: TabHost) => Tab> = {
  shelf: shelfTab,
  reminders: remindersTab,
  notes: notesTab,
  tools: toolsTab,
};

const LAST_TAB_KEY = "pod.island.lastTab";

/**
 * Sent on `window` when a shortcut opens a tab for something in particular
 * (`detail`: { tab, intent }, intent "new" for New reminder / Quick note,
 * "clipboard" for Smart clipboard). A tab may listen while shown.
 */
export const TAB_INTENT_EVENT = "pod-tab-intent";

/** The tabs whose feature is on, in header order. */
export function visibleTabs(disabled: readonly string[] = []): TabId[] {
  const off = new Set(disabled);
  return TAB_IDS.filter((id) => !off.has(id));
}

/** The tab to show: the current one if still there, else the remembered one, else the first. */
export function pickTab(visible: readonly TabId[], current: TabId | null, remembered: string | null): TabId | null {
  if (current && visible.includes(current)) return current;
  if (remembered && (visible as readonly string[]).includes(remembered)) return remembered as TabId;
  return visible[0] ?? null;
}

function readLast(): string | null {
  try {
    return window.localStorage?.getItem(LAST_TAB_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeLast(id: TabId) {
  try {
    window.localStorage?.setItem(LAST_TAB_KEY, id);
  } catch {
    // Storage refused: the island opens on the first tab next time.
  }
}

/** What the tabs need from the island. */
export interface TabsIsland {
  /** Holds the island open while a tab is busy (typing, dragging). */
  hold(id: TabId, on: boolean): void;
  /** A tab's wanted height changed. */
  resized(id: TabId): void;
  close(): void;
  sound(name: string): void;
  /** Gives the island the keyboard (a field is about to be focused again). */
  takeKeyboard(): void;
}

/** A field left focused when the island folds is focused again if it reopens within this. */
export const RESUME_MS = 15_000;

/** A tab that failed to build: an empty one, so the island lives on. */
function emptyTab(id: TabId): Tab {
  return { id, el: h("div"), show() {}, hide() {}, height: () => 120 };
}

export class IslandTabs {
  /** Mounted in the overview view: one absolutely placed pane per tab. */
  readonly el: HTMLElement;
  private tabs = new Map<TabId, Tab>();
  private shown: TabId | null = null;
  /** The field the user was in when the island folded (a pointer slip), to pick up again. */
  private resume: { tab: TabId; el: HTMLElement; at: number } | null = null;

  private island: TabsIsland;

  constructor(island: TabsIsland) {
    this.island = island;
    this.el = h("div", { class: "tab-stack" });
    for (const id of TAB_IDS) {
      const host: TabHost = {
        hold: (on) => island.hold(id, on),
        resize: () => island.resized(id),
        close: () => island.close(),
        sound: (name) => island.sound(name),
      };
      let tab: Tab;
      try {
        tab = FACTORIES[id](host);
      } catch (err) {
        console.error(`[pod] the ${id} tab failed to build`, err);
        tab = emptyTab(id);
      }
      tab.el.classList.add("tab-pane");
      tab.el.dataset.tab = id;
      this.tabs.set(id, tab);
      this.el.append(tab.el);
    }
    this.refresh();
  }

  /** Settings changed: which tabs there are, and which one is current. */
  refresh() {
    const visible = visibleTabs(State.settings.disabledFeatures ?? []);
    if (visible.join(",") !== State.tabs.join(",")) State.tabs = visible;
    State.tab = pickTab(visible, State.tab, readLast());
  }

  /** The current tab; remembered for the next launch. */
  select(id: TabId): boolean {
    if (!State.tabs.includes(id)) return false;
    State.tab = id;
    writeLast(id);
    return true;
  }

  get any(): boolean {
    return State.tabs.length > 0;
  }

  /** The island's height for the current tab. */
  islandHeight(): number | null {
    const tab = State.tab ? this.tabs.get(State.tab) : undefined;
    if (!tab) return null;
    let want = NaN;
    try {
      want = tab.height();
    } catch {
      // A tab that can't say: the smallest island.
    }
    return tabsIslandHeight(want);
  }

  /** Shows the current tab while `open`, hides it otherwise. */
  sync(open: boolean) {
    const want = open ? State.tab : null;
    if (want === this.shown) return;
    if (this.shown) {
      const old = this.tabs.get(this.shown);
      const active = typeof document !== "undefined" ? document.activeElement : null;
      this.resume = !open && old && active instanceof HTMLElement && old.el.contains(active)
        ? { tab: this.shown, el: active, at: Date.now() }
        : null;
      old?.el.classList.remove("on");
      try {
        old?.hide();
      } catch (err) {
        console.error("[pod] tab hide failed", err);
      }
    }
    this.shown = want;
    if (want) {
      const tab = this.tabs.get(want);
      tab?.el.classList.add("on");
      try {
        tab?.show();
      } catch (err) {
        console.error("[pod] tab show failed", err);
      }
      const r = this.resume;
      this.resume = null;
      if (r && r.tab === want && r.el.isConnected && Date.now() - r.at < RESUME_MS) {
        // Back to where the pointer slipped off: same field, same caret.
        this.island.takeKeyboard();
        requestAnimationFrame(() => r.el.focus({ preventScroll: true }));
      }
    }
  }

  /** The tab on screen, if any. */
  get current(): TabId | null {
    return this.shown;
  }
}
