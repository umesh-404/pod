// The Pod window: a sidebar with every setting of the island, and the
// page on the right, under its coloured band. Port of FlowHub.swift.

import "./hub.css";
import { h, clear } from "../views/dom";
import { t, onLanguageChange } from "../i18n/i18n";
import { Bridge, onEvent } from "../core/bridge";
import { hero, liveMochi, setWindowShown } from "./hero";
import { icon } from "./ui";
import { searchSettings, type SettingsSearchHit } from "./search";

export type PageId = "general" | "notch" | "features" | "shortcuts";

interface PageDef {
  id: PageId;
  icon: string;
  title: () => string;
  subtitle: () => string;
}

export const NOTCH_PAGES: PageDef[] = [
  { id: "general", icon: "gear", title: () => t("General"), subtitle: () => t("Mochi, his sounds and how the island behaves.") },
  { id: "notch", icon: "notch", title: () => t("Notch"), subtitle: () => t("What the notch shows, your calendar links and the focus timer.") },
  { id: "features", icon: "grid", title: () => t("Features"), subtitle: () => t("Switch off what you don't use: it disappears from the island.") },
  { id: "shortcuts", icon: "keyboard", title: () => t("Shortcuts"), subtitle: () => t("The keys that open the island and its actions.") },
];

const ALL = NOTCH_PAGES;

export interface HubOptions {
  version: string;
  /** Draws the island's settings for one page into `container`. */
  renderPage(page: PageId, container: HTMLElement): Promise<void>;
}

export async function startHub(root: HTMLElement, opts: HubOptions) {
  document.body.classList.add("hub-window");
  // The window is created hidden and only shown and hidden afterwards: its
  // canvases animate only while it is on screen (#792).
  await onEvent<boolean>("hub-visible", setWindowShown);
  const shown = await Bridge.hubShown();
  if (shown !== null) setWindowShown(shown);
  let current: PageId = "general";
  let activeAnchor: string | null = null;
  let searchHits: SettingsSearchHit[] = [];
  const items = new Map<PageId, HTMLElement>();
  const labels = new Map<PageId, HTMLElement>();
  const searchRows = new Map<string, HTMLElement>();
  const scroll = h("div", { class: "hub-scroll" });
  let rendering = 0;

  function updateSearchRowHighlights() {
    for (const [id, rowEl] of searchRows) {
      rowEl.classList.toggle("on", id === activeAnchor);
    }
  }

  async function show(page: PageId, targetAnchor?: string) {
    const def = ALL.find((p) => p.id === page) ?? ALL[0];
    current = def.id;
    activeAnchor = targetAnchor ?? null;
    for (const [id, el] of items) el.classList.toggle("on", id === current);
    updateSearchRowHighlights();
    const token = ++rendering;
    const page_ = h("div", { class: "hub-page" });
    page_.append(hero(def.id, def.title(), def.subtitle()));
    const container = h("div", { id: "settings-root" });
    page_.append(container);
    await opts.renderPage(def.id, container);
    if (token !== rendering) return;
    clear(scroll);
    scroll.append(page_);
    if (targetAnchor) {
      const el = page_.querySelector(`[data-anchor="${targetAnchor}"]`) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.remove("hub-card-glowing");
        void el.offsetWidth;
        el.classList.add("hub-card-glowing");
      } else {
        scroll.scrollTop = 0;
      }
    } else {
      scroll.scrollTop = 0;
    }
  }

  // ── The sidebar ──
  const side = h("nav", { class: "hub-side" });
  const logo = h("canvas", {});
  side.append(h("div", { class: "hub-brand" }, logo, h("span", { text: "Pod" })));
  liveMochi(logo as HTMLCanvasElement);

  // Settings search field
  const searchInput = h("input", {
    class: "hub-search-input",
    type: "text",
    placeholder: t("Search settings"),
    spellcheck: "false",
  }) as HTMLInputElement;

  const searchClear = h("button", {
    class: "hub-search-clear",
    title: t("Close"),
    style: "display:none",
  }, icon("x"));

  const searchBox = h("div", { class: "hub-search" },
    icon("search"),
    searchInput,
    searchClear,
  );
  searchBox.querySelector("svg")?.classList.add("hub-search-icon");
  side.append(searchBox);

  const groupsContainer = h("div", { class: "hub-groups" });
  const resultsContainer = h("div", { class: "hub-search-results", style: "display:none" });
  side.append(groupsContainer, resultsContainer);

  const group = (title: string, pages: PageDef[]) => {
    const heading = h("div", { class: "hub-group", text: title });
    groupsContainer.append(heading);
    for (const p of pages) {
      const b = h("button", { class: "hub-item", onclick: () => void show(p.id) });
      const label = h("span", { text: p.title() });
      b.append(icon(p.icon), label);
      items.set(p.id, b);
      labels.set(p.id, label);
      groupsContainer.append(b);
    }
    return heading;
  };
  const notchGroup = group(t("Notch"), NOTCH_PAGES);

  function renderSearchResults() {
    clear(resultsContainer);
    searchRows.clear();
    const query = searchInput.value.trim();
    if (!query) {
      searchClear.style.display = "none";
      resultsContainer.style.display = "none";
      groupsContainer.style.display = "";
      searchHits = [];
      return;
    }
    searchClear.style.display = "";
    groupsContainer.style.display = "none";
    resultsContainer.style.display = "";
    searchHits = searchSettings(query, (pageId) => ALL.find((p) => p.id === pageId)?.title() ?? pageId);
    if (searchHits.length === 0) {
      resultsContainer.append(h("div", { class: "hub-search-empty", text: t("No setting found") }));
      return;
    }
    for (const hit of searchHits) {
      const pageDef = ALL.find((p) => p.id === hit.entry.page);
      const row = h("button", { class: "hub-search-row" });
      if (activeAnchor === hit.entry.id && current === hit.entry.page) {
        row.classList.add("on");
      }
      row.append(icon(pageDef?.icon ?? "sliders"));
      const textContainer = h("div", { class: "hub-search-row-text" });
      const rowTitle = h("div", { class: "hub-search-row-title", text: hit.label ?? t(hit.entry.title) });
      const rowSubtitle = h("div", {
        class: "hub-search-row-subtitle",
        text: hit.label
          ? `${pageDef?.title() ?? ""} › ${t(hit.entry.title)}`
          : (pageDef?.title() ?? ""),
      });
      textContainer.append(rowTitle, rowSubtitle);
      row.append(textContainer);
      row.addEventListener("click", () => {
        void show(hit.entry.page, hit.entry.id);
      });
      searchRows.set(hit.entry.id, row);
      resultsContainer.append(row);
    }
  }

  searchInput.addEventListener("input", renderSearchResults);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      renderSearchResults();
    } else if (e.key === "Enter") {
      if (searchHits.length > 0) {
        void show(searchHits[0].entry.page, searchHits[0].entry.id);
      }
    }
  });

  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    renderSearchResults();
    searchInput.focus();
  });

  onLanguageChange(() => {
    searchInput.placeholder = t("Search settings");
    if (searchInput.value.trim()) renderSearchResults();
  });

  side.append(h("div", { class: "spacer" }), h("div", { class: "hub-version", text: `Pod ${opts.version}` }));

  clear(root);
  root.append(side, h("main", { class: "hub-panel" }, scroll));
  await show(current);

  void onEvent<string>("hub-page", (page) => {
    const id = (page === "settings" ? "general" : page) as PageId;
    if (ALL.some((p) => p.id === id)) void show(id);
  });
  return {
    redraw: () => {
      for (const p of ALL) {
        const label = labels.get(p.id);
        if (label) label.textContent = p.title();
      }
      notchGroup.textContent = t("Notch");
      void show(current);
    },
    current: () => current,
  };
}
