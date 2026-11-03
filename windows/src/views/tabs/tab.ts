// The expanded island's tabs (Shelf, Reminders, Notes, Tools). Each tab is a
// self-contained view: the island (island.ts) builds it once, puts `el` in its
// content area, and calls show()/hide() as the user switches tabs or the island
// opens and folds. A hidden tab stops its timers and watchers.

export type TabId = "shelf" | "reminders" | "notes" | "tools";

/** What the island offers a tab. */
export interface TabHost {
  /** Keeps the island open while the user is typing or dragging (auto-close paused). */
  hold(on: boolean): void;
  /** The tab's content changed height: the island re-measures and springs to it. */
  resize(): void;
  /** Folds the island back to the compact notch. */
  close(): void;
  /** Plays one of the app's sounds by name ("success", "error"…; see core/sound.ts). */
  sound(name: string): void;
}

export interface Tab {
  id: TabId;
  el: HTMLElement;
  show(): void;
  hide(): void;
  /** Wanted content height in px at the island's tab width (TAB_WIDTH in core/layout.ts). */
  height(): number;
}
