// Keyboard shortcuts → island. Port of IslandWindowController.handleHotKey and
// handleIslandKey from the macOS app.
//
// Global shortcuts are caught by Rust and arrive as a `shortcut` event with
// the action id (the wardrobe goes out as `open-wardrobe` instead, for the
// wardrobe view to pick up). The in-island keys are read here, while the
// island has the keyboard: it takes it when a global shortcut opens it.

import { Bridge, onEvent } from "../core/bridge";
import type { BotEmoteName, IslandViewName } from "../core/layout";
import { islandKeyAction, type IslandKeyAction } from "../core/shortcuts";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { TabId } from "../views/tabs/tab";

/** What the shortcuts need from the island. */
export interface ShortcutHost {
  alert(view: IslandViewName): void;
  collapse(): void;
  emote(name: BotEmoteName): void;
  setPinned(on: boolean): void;
  /** Gives the island the keyboard, so the in-island keys work (Mac: makeKey). */
  takeKeyboard(): void;
  /** The wardrobe from any state, or back if it is open (Island.wardrobeAnywhere). */
  wardrobeAnywhere(): void;
  /** False where Stew can't leave the island (GNOME on Wayland). */
  canLeaveIsland(): boolean;
  /** Stew out to the desktop, or home (DesktopMochiController.flyOutOrHome). */
  flyOutOrHome(): void;
  /** Opens a tab of the open island; `intent` tells it why (island/tabs.ts). */
  openTab(id: TabId, intent?: string): void;
}

/** A workspace shortcut whose feature is off: Stew says no. */
function refuse(host: ShortcutHost) {
  host.emote("annoyed");
  Sound.play("error");
}

const featureOff = (id: string) => (State.settings.disabledFeatures ?? []).includes(id);

/** Opens a tab from a shortcut, with the keyboard, unless its feature is off. */
function shortcutTab(host: ShortcutHost, resume: () => void, id: TabId, intent?: string) {
  if (featureOff(id)) {
    refuse(host);
    return;
  }
  resume();
  host.openTab(id, intent);
  host.takeKeyboard();
}

/** A global shortcut was pressed. `resume` lifts Pause, as the tray's Open does. */
export function runGlobalShortcut(host: ShortcutHost, action: string, resume: () => void) {
  switch (action) {
    case "toggleIsland":
      if (State.mode === "expanded") {
        host.collapse();
      } else {
        resume();
        host.alert(State.defaultView());
        host.takeKeyboard();
      }
      break;

    case "muteToggle": {
      const on = !State.settings.soundEnabled;
      State.settings.soundEnabled = on;
      Sound.setEnabled(on);
      void Bridge.saveSettings(State.settings);
      if (on) Sound.play("tick");
      host.emote(on ? "happy" : "annoyed");
      State.notify();
      break;
    }

    // The Mac's ⌃⌥D. Sending him out lifts Pause, as the other shortcuts do;
    // where he can't leave the island, Stew says so.
    case "desktopToggle":
      if (!host.canLeaveIsland()) {
        host.emote("annoyed");
        Sound.play("error");
        break;
      }
      if (!State.mochiOnDesktop) resume();
      host.flyOutOrHome();
      break;

    // The shelf's shortcut opens it, or closes the island when it is already on it.
    case "openShelf":
      if (State.mode === "expanded" && State.view === "overview" && State.tab === "shelf") host.collapse();
      else shortcutTab(host, resume, "shelf");
      break;

    case "newReminder":
      shortcutTab(host, resume, "reminders", "new");
      break;

    case "quickNote":
      shortcutTab(host, resume, "notes", "new");
      break;

    case "smartClipboard":
      shortcutTab(host, resume, "tools", "clipboard");
      break;

    // The snipping overlay; the picture lands on the shelf.
    case "screenshot":
      if (featureOff("capture") || featureOff("shelf")) {
        refuse(host);
        break;
      }
      resume();
      Bridge.captureToShelf().then(
        () => {
          Sound.play("pop");
          host.emote("happy");
        },
        (err) => {
          if (!/cancel/i.test(String(err))) Sound.play("error");
        },
      );
      break;

    // wardrobeToggle never comes this way (Rust sends `open-wardrobe`).
    default:
      break;
  }
}

/** A key the island acts on while it has the keyboard. */
export function runIslandKey(host: ShortcutHost, action: IslandKeyAction) {
  switch (action.kind) {
    case "settings":
      void Bridge.openSettingsWindow();
      break;
    case "pin":
      host.setPinned(!State.isPinned);
      break;
  }
}

export function registerShortcutHandlers(host: ShortcutHost, resume: () => void) {
  void onEvent<string>("shortcut", (action) => runGlobalShortcut(host, action, resume));
  // The wardrobe shortcut comes as its own event (shortcuts.rs): it opens the
  // wardrobe (mochi/wardrobe.ts, views/wardrobe.ts), or closes it again.
  void onEvent<null>("open-wardrobe", () => {
    resume();
    host.wardrobeAnywhere();
  });

  // Capture phase: a field in a card may stop its own key events from bubbling.
  window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (State.mode !== "expanded") return;
      const action = islandKeyAction(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      runIslandKey(host, action);
    },
    true,
  );
}
