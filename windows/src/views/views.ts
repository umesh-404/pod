// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { State } from "../core/state";
import { DEFAULT_DROP_TILES, hidesHeader, washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { buildDropTargets, buildFileAction, type FileCardActions } from "./files";
import { dropAction } from "../island/file-actions";
import type { TabId } from "./tabs/tab";
import { buildWardrobe } from "./wardrobe";
import { buildUpdate } from "./update";
import { buildWhatsNew } from "./whatsnew";
import type { Outfit, OutfitSelection } from "../mochi/wardrobe";
import { N_, t, tl, type Msg } from "../i18n/i18n";

export interface ViewActions {
  setView(v: IslandViewName): void;
  /** Opens a tab (Shelf, Reminders, Notes, Tools) in the open island. */
  setTab(id: TabId): void;
  collapse(): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  /** Opens the workspace folder in the file manager. */
  openWorkspace(): void;
  blip(): void;
  /** Wardrobe click: keeps the outfit ("auto" and "none" included). */
  chooseOutfit(selection: OutfitSelection): void;
  /** Wardrobe hover: shows an outfit on Stew without keeping it; null ends it. */
  previewOutfit(outfit: Outfit | null): void;
  /** The buttons of the file action card (island/file-actions.ts). */
  fileCard: FileCardActions;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called every frame while the view is on screen. True = needs another frame. */
  tick?(nowMs: number): boolean | void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string | Msg,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

// ── Header ────────────────────────────────────────────────────────────────────

/** The tabs' buttons, in header order. */
const TAB_BUTTONS: readonly { id: TabId; title: string; icon: keyof typeof ICONS }[] = [
  { id: "shelf", title: N_("Shelf"), icon: "tray" },
  { id: "reminders", title: N_("Reminders"), icon: "bell" },
  { id: "notes", title: N_("Notes"), icon: "note" },
  { id: "tools", title: N_("Tools"), icon: "wrench" },
];

/** A tab button's width plus the gap between two (style.css: .tab, .tabs). */
const TAB_STEP = 35;

export function buildHeader(actions: ViewActions): ViewHost {
  // Without any tab (all switched off), the old Home button stands alone.
  const tabHome = h("button", { class: "tab", title: tl("Overview"), onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabButtons = new Map<TabId, HTMLElement>(
    TAB_BUTTONS.map((b) => [
      b.id,
      h("button", {
        class: "tab",
        title: tl(b.title),
        "data-tab": b.id,
        onclick: () => {
          actions.blip();
          actions.setTab(b.id);
        },
      }, svg(ICONS[b.icon], 14, { stroke: 1.7 })),
    ]),
  );
  // The selection slides between the buttons (transform only).
  const indicator = h("div", { class: "tab-indicator" });
  const tabsEl = h("div", { class: "tabs" }, indicator, tabHome, ...tabButtons.values());
  let tabsKey = "";

  const gearBtn = h("button", { title: tl("Settings"), onclick: () => go("settings") }, svg(ICONS.settings, 15, { stroke: 1.7 }));
  const soundBtn = h("button", { title: tl("Mute"), onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    tabsEl,
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      const shown = State.tabs;
      const key = shown.join(",");
      if (key !== tabsKey) {
        tabsKey = key;
        tabHome.style.display = shown.length === 0 ? "" : "none";
        for (const [id, b] of tabButtons) b.style.display = shown.includes(id) ? "" : "none";
        // Stew sits in the header's left corner while a tab is open.
        tabsEl.classList.toggle("with-tabs", shown.length > 0);
      }
      const at = v === "overview" && State.tab ? shown.indexOf(State.tab) : -1;
      for (const [id, b] of tabButtons) b.classList.toggle("on", at >= 0 && id === State.tab);
      indicator.style.opacity = at >= 0 ? "1" : "0";
      if (at >= 0) indicator.style.transform = `translateX(${at * TAB_STEP}px)`;
      tabHome.classList.toggle("on", v === "overview" && shown.length === 0);
      gearBtn.classList.toggle("on", v === "settings");
      // Redrawn only when the sound is switched: a new icon under the pointer
      // between its press and release on every notify is needless churn.
      if (soundBtn.getAttribute("aria-pressed") !== String(!State.settings.soundEnabled)) {
        clear(soundBtn);
        soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
        // "Mute" is a toggle: pressed while the sound is off.
        soundBtn.setAttribute("aria-pressed", String(!State.settings.soundEnabled));
      }
      // The drop tiles take the whole island: the header fades out (it keeps its
      // room, so nothing moves) and the tiles' view covers it.
      const noHeader = hidesHeader(v);
      el.style.opacity = v === "confused" || noHeader ? "0" : "1";
      if (noHeader) el.style.pointerEvents = "none";
    },
  };
}

// ── Home ──────────────────────────────────────────────────────────────────────

/** The island at rest: Stew on the left, what a drop on the island can do. */
function buildHome(actions: ViewActions): ViewHost {
  // What the drop tiles offer, in their own words (island/file-actions.ts).
  const sub = h("div", { class: "sub" });
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px;min-width:0" },
      h("div", { class: "title", text: tl("Drop your files here") }),
      sub,
    ),
    h("div", { class: "grow" }),
    btn(tl("Open folder"), "secondary", () => actions.openWorkspace()),
  );
  const homeCard = card(null, body);
  homeCard.classList.add("home-card");
  return {
    // The tabs mount in here too (island.ts); while one shows, the card steps aside.
    el: h("div", { class: "view overview" }, homeCard),
    sync() {
      const text = DEFAULT_DROP_TILES.map((id) => t(dropAction(id).title)).join(" · ");
      if (sub.textContent !== text) sub.textContent = text;
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: tl("Too many hits at once.") }),
    h("div", { class: "sub", text: tl("Give me a sec — back to work in three seconds.") }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  // A switch with no text of its own: screen readers hear its row's name and state.
  const soundSwitch = h("button", { class: "switch", "aria-label": tl("Sound"), onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005", "aria-label": tl("Volume"),
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: tl("Sound") }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: tl("Settings…"),
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      soundSwitch.setAttribute("aria-pressed", String(s.soundEnabled));
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = t("Auto-close · {seconds}s", { seconds: Math.round(s.autoCloseInterval) });
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
    },
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(actions: ViewActions): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildHome(actions));
  map.set("confused", buildConfused());
  map.set("settings", buildSettings(actions));
  map.set("wardrobe", buildWardrobe(actions));
  map.set("update", buildUpdate());
  map.set("whatsNew", buildWhatsNew());
  map.set("dropTargets", buildDropTargets());
  map.set("fileAction", buildFileAction(actions.fileCard));
  return map;
}
