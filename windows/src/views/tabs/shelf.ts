// The Shelf tab: what is in the workspace folder, as a grid of tiles.
// Thumbnails load lazily (only tiles scrolled into view ask Rust for one) and
// are cached by name + modified time. Click selects, Ctrl toggles, Shift
// extends; dragging a tile out starts a native drag from Rust; double-click
// opens; Delete sends the selection to the Recycle Bin.

import { Bridge, type ShelfItem } from "../../core/bridge";
import { h, svg } from "../dom";
import { ICONS } from "../icons";
import { tl, tn } from "../../i18n/i18n";
import { GLYPHS } from "./glyphs";
import { clampHeight, formatAge, formatSize, holder, listenWhile, middleEllipsis, tabWidth } from "./common";
import type { Tab, TabHost } from "./tab";

const TILE_W = 92;
const TILE_H = 98;
const THUMB_PX = 64;
const GAP = 8;
const PAD = 12;
const HEAD_H = 28;
/** Pointer travel (px) before a press turns into a drag out of the island. */
const DRAG_THRESHOLD = 4;

const THUMB_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "ico", "heic", "avif", "svg",
  "pdf", "mp4", "mov", "mkv", "webm", "avi", "m4v",
  // Only when Windows has a thumbnail for them (Office installed); else the placeholder.
  "docx", "xlsx", "pptx",
]);
/** Pages: their thumbnail is pinned to the top, where a document starts. */
const PAGE_EXT = new Set(["pdf", "docx", "xlsx", "pptx"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "ico", "heic", "avif", "svg"]);
const VIDEO_EXT = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v"]);
const AUDIO_EXT = new Set(["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus"]);
const ARCHIVE_EXT = new Set(["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz"]);

/** Thumbnails by `name|modified` (null: Rust has none for it). Shared, survives tab rebuilds. */
const thumbCache = new Map<string, string | null>();
const THUMB_CACHE_MAX = 300;

/** Rust wants the thumbnail size in physical pixels. */
function thumbPhysicalPx(): number {
  const dpr = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return Math.round(THUMB_PX * dpr);
}

function thumbKey(item: ShelfItem): string {
  return `${item.name}|${item.modified}`;
}

function placeholderIcon(item: ShelfItem): SVGSVGElement {
  const ext = item.ext.toLowerCase();
  if (item.isDir) return svg(ICONS.folder, 26);
  if (IMAGE_EXT.has(ext)) return svg(GLYPHS.photo, 26, { stroke: 1.6 });
  if (VIDEO_EXT.has(ext)) return svg(GLYPHS.film, 26, { stroke: 1.6 });
  if (AUDIO_EXT.has(ext)) return svg(ICONS.musicNote, 26);
  if (ARCHIVE_EXT.has(ext)) return svg(ICONS.archive, 26, { evenOdd: true });
  return svg(ICONS.doc, 26);
}

/** Rows the grid needs for `count` items at the tab width. */
export function shelfColumns(width = tabWidth()): number {
  return Math.max(1, Math.floor((width - PAD * 2 + GAP) / (TILE_W + GAP)));
}

export function shelfHeight(count: number, width = tabWidth()): number {
  if (count === 0) return clampHeight(0);
  const rows = Math.ceil(count / shelfColumns(width));
  return clampHeight(PAD + HEAD_H + GAP + rows * TILE_H + (rows - 1) * GAP + PAD);
}

interface TileView {
  el: HTMLElement;
  thumb: HTMLElement;
  key: string;
  observed: boolean;
}

export function shelfTab(host: TabHost): Tab {
  const hold = holder(host);
  let items: ShelfItem[] = [];
  let shown = false;
  let lastHeight = shelfHeight(0);
  const selected = new Set<string>();
  let anchor: string | null = null;
  const tiles = new Map<string, TileView>();
  let unlisten: (() => void) | null = null;
  let observer: IntersectionObserver | null = null;

  const count = h("div", { class: "tab-count" });
  const openFolder = h(
    "button",
    {
      class: "tab-link",
      onclick: () => {
        Bridge.workspaceOpen().catch(() => host.sound("error"));
      },
    },
    svg(ICONS.folder, 12),
    h("span", { text: tl("Open folder") }),
  );
  // Files can also come from the picker, not only from a drop on the notch.
  let picking = false;
  async function addFiles() {
    if (picking) return;
    picking = true;
    // The picker takes the pointer away: the island stays until it closes.
    hold.set(true);
    try {
      const added = await Bridge.shelfAdd();
      if (added.length) host.sound("success");
    } catch {
      host.sound("error");
    } finally {
      picking = false;
      hold.set(false);
    }
  }
  const addBtn = h(
    "button",
    { class: "tab-link", onclick: () => void addFiles() },
    svg(ICONS.plus, 12),
    h("span", { text: tl("Add files") }),
  );
  const head = h("div", { class: "tab-head" }, count, h("div", { class: "tab-head-actions" }, addBtn, openFolder));
  const grid = h("div", { class: "shelf-grid", tabindex: "0", role: "listbox", "aria-multiselectable": "true", "aria-orientation": "horizontal" });
  // The tiles are one row: an up/down wheel scrolls it sideways.
  grid.addEventListener("wheel", (e) => {
    if (grid.scrollWidth <= grid.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    grid.scrollBy({ left: e.deltaY });
  }, { passive: false });
  const empty = h(
    "div",
    { class: "tab-empty" },
    h("div", { class: "tab-empty-icon" }, svg(ICONS.stack, 22)),
    h("div", { class: "tab-empty-text", text: tl("Drop files on the notch to keep them here") }),
    h(
      "button",
      { class: "tab-add", onclick: () => void addFiles() },
      svg(ICONS.plus, 12),
      h("span", { text: tl("Add files") }),
    ),
  );
  const el = h("div", { class: "tab-view tab-shelf" }, head, grid, empty);

  grid.addEventListener("pointerenter", () => endDrag());
  grid.addEventListener("keydown", ((e: KeyboardEvent) => {
    if (/^(?:Delete|Backspace)$/.test(e.key)) {
      e.preventDefault();
      remove([...selected]);
    } else if (e.key === "Escape" && selected.size > 0) {
      e.preventDefault();
      e.stopPropagation();
      selected.clear();
      paintSelection();
    } else if (e.key === "Enter" && selected.size === 1) {
      e.preventDefault();
      open([...selected][0]);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      for (const it of items) selected.add(it.name);
      paintSelection();
    }
  }) as EventListener);

  // ── Actions ────────────────────────────────────────────────────────────────

  function open(name: string) {
    Bridge.shelfOpen(name).catch(() => host.sound("error"));
  }

  function remove(names: string[]) {
    if (names.length === 0) return;
    for (const n of names) tiles.get(n)?.el.classList.add("leaving");
    Bridge.shelfRemove(names)
      .then(() => {
        for (const n of names) selected.delete(n);
        host.sound("pop");
        void refresh();
      })
      .catch(() => {
        for (const n of names) tiles.get(n)?.el.classList.remove("leaving");
        host.sound("error");
      });
  }

  function select(name: string, e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) {
    if (e.shiftKey && anchor && items.some((i) => i.name === anchor)) {
      const a = items.findIndex((i) => i.name === anchor);
      const b = items.findIndex((i) => i.name === name);
      const [from, to] = a < b ? [a, b] : [b, a];
      if (!(e.ctrlKey || e.metaKey)) selected.clear();
      for (let i = from; i <= to; i++) selected.add(items[i].name);
    } else if (e.ctrlKey || e.metaKey) {
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
      anchor = name;
    } else {
      selected.clear();
      selected.add(name);
      anchor = name;
    }
    paintSelection();
  }

  function paintSelection() {
    for (const [name, tile] of tiles) {
      const on = selected.has(name);
      tile.el.classList.toggle("selected", on);
      tile.el.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  // ── Drag out ───────────────────────────────────────────────────────────────

  let press: { name: string; x: number; y: number; id: number } | null = null;
  let dragging = false;
  let swallowClick = false;

  function startDrag(name: string) {
    if (!selected.has(name)) {
      selected.clear();
      selected.add(name);
      anchor = name;
      paintSelection();
    }
    // Keep the shelf's order, so the files land in the order they show.
    const names = items.map((i) => i.name).filter((n) => selected.has(n));
    dragging = true;
    swallowClick = true;
    el.classList.add("dragging");
    hold.set(true);
    // Right away, while the button is still down: the native drag needs it held.
    Bridge.shelfDrag(names)
      .catch(() => host.sound("error"))
      .finally(endDrag);
  }

  /**
   * The native drag is modal and swallows the pointerup: the drag state ends
   * when the call returns, or at the next pointerdown / pointerenter.
   */
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("dragging");
    hold.set(false);
  }

  // ── Tiles ──────────────────────────────────────────────────────────────────

  function loadThumb(item: ShelfItem, view: TileView) {
    const key = thumbKey(item);
    if (thumbCache.has(key)) {
      putThumb(view, thumbCache.get(key) ?? null, false);
      return;
    }
    void Bridge.shelfThumb(item.name, thumbPhysicalPx()).then((url) => {
      if (thumbCache.size >= THUMB_CACHE_MAX) {
        const first = thumbCache.keys().next().value;
        if (first !== undefined) thumbCache.delete(first);
      }
      thumbCache.set(key, url ?? null);
      // The tile may have been replaced (the file changed) while Rust worked.
      if (view.key === key) putThumb(view, url ?? null, true);
    });
  }

  function putThumb(view: TileView, url: string | null, fade: boolean) {
    if (!url || view.thumb.querySelector(".shelf-img")) return;
    const img = h("img", { class: "shelf-img", src: url, alt: "", draggable: "false", decoding: "async" });
    if (fade) {
      img.addEventListener("load", () => img.classList.add("loaded"));
      img.addEventListener("error", () => img.remove());
    } else {
      img.classList.add("loaded", "instant");
    }
    view.thumb.append(img);
    view.thumb.classList.add("has-img");
  }

  function wantsThumb(item: ShelfItem) {
    return !item.isDir && THUMB_EXT.has(item.ext.toLowerCase());
  }

  function makeTile(item: ShelfItem): TileView {
    const ext = item.isDir ? "" : item.ext.toUpperCase();
    const thumb = h(
      "div",
      { class: `shelf-thumb${PAGE_EXT.has(item.ext.toLowerCase()) ? " page" : ""}` },
      h("div", { class: "shelf-ph" }, placeholderIcon(item), ext ? h("span", { class: "shelf-ext", text: ext.slice(0, 4) }) : null),
    );
    const meta = h("div", { class: "shelf-meta", text: [item.isDir ? "" : formatSize(item.size), formatAge(item.modified)].filter(Boolean).join(" · ") });
    const del = h(
      "button",
      {
        class: "shelf-del",
        title: tl("Move to Recycle Bin"),
        "aria-label": tl("Move to Recycle Bin"),
        onclick: ((e: MouseEvent) => {
          e.stopPropagation();
          remove(selected.has(item.name) ? [...selected] : [item.name]);
        }) as EventListener,
        onpointerdown: ((e: PointerEvent) => e.stopPropagation()) as EventListener,
        ondblclick: ((e: MouseEvent) => e.stopPropagation()) as EventListener,
      },
      svg(GLYPHS.trash, 12, { stroke: 1.8 }),
    );
    const tile = h(
      "div",
      { class: "shelf-tile", role: "option", title: item.name, "aria-selected": "false", "data-name": item.name, draggable: "false" },
      thumb,
      meta,
      del,
      h("div", { class: "shelf-name", text: middleEllipsis(item.name, 20) }),
    );
    const view: TileView = { el: tile, thumb, key: thumbKey(item), observed: false };
    // The entrance plays once: re-ordering the grid later must not replay it.
    tile.addEventListener("animationend", () => tile.classList.add("settled"));

    // WebView2 must not start an HTML5 drag of its own: Rust does the real one.
    tile.addEventListener("dragstart", ((e: DragEvent) => e.preventDefault()) as EventListener);
    tile.addEventListener("pointerdown", ((e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      endDrag();
      press = { name: item.name, x: e.clientX, y: e.clientY, id: e.pointerId };
      swallowClick = false;
    }) as EventListener);
    tile.addEventListener("pointermove", ((e: PointerEvent) => {
      if (!press || press.name !== item.name || dragging) return;
      if ((e.buttons & 1) === 0) {
        press = null;
        return;
      }
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) >= DRAG_THRESHOLD) {
        press = null;
        startDrag(item.name);
      }
    }) as EventListener);
    tile.addEventListener("pointerup", () => {
      press = null;
    });
    tile.addEventListener("click", ((e: MouseEvent) => {
      if (swallowClick) {
        swallowClick = false;
        return;
      }
      grid.focus();
      select(item.name, e);
    }) as EventListener);
    tile.addEventListener("dblclick", ((e: MouseEvent) => {
      e.preventDefault();
      open(item.name);
    }) as EventListener);

    if (wantsThumb(item)) {
      const cached = thumbCache.get(view.key);
      if (cached !== undefined) putThumb(view, cached, false);
      else if (observer) {
        observer.observe(tile);
        view.observed = true;
      } else loadThumb(item, view);
    }
    return view;
  }

  function ensureObserver() {
    if (observer || typeof IntersectionObserver === "undefined") return;
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const name = (entry.target as HTMLElement).getAttribute("data-name") ?? "";
          const item = items.find((i) => i.name === name);
          const view = tiles.get(name);
          observer?.unobserve(entry.target);
          if (item && view) {
            view.observed = false;
            loadThumb(item, view);
          }
        }
      },
      // A row ahead, so thumbnails are there by the time they scroll in.
      { root: grid, rootMargin: `${TILE_H}px 0px` },
    );
  }

  function render() {
    ensureObserver();
    const names = new Set(items.map((i) => i.name));
    for (const [name, view] of tiles) {
      if (!names.has(name)) {
        if (view.observed) observer?.unobserve(view.el);
        tiles.delete(name);
      }
    }
    for (const n of [...selected]) if (!names.has(n)) selected.delete(n);
    const ordered: HTMLElement[] = [];
    for (const item of items) {
      let view = tiles.get(item.name);
      if (!view || view.key !== thumbKey(item)) {
        if (view?.observed) observer?.unobserve(view.el);
        view = makeTile(item);
        tiles.set(item.name, view);
      }
      ordered.push(view.el);
    }
    // Reuses the existing nodes, and leaves the grid alone when nothing moved.
    const now = grid.children;
    if (now.length !== ordered.length || ordered.some((n, i) => now[i] !== n)) grid.replaceChildren(...ordered);
    paintSelection();

    count.textContent = items.length ? tn("{count} item", "{count} items", items.length) : "";
    el.classList.toggle("is-empty", items.length === 0);
    const next = shelfHeight(items.length);
    if (next !== lastHeight) {
      lastHeight = next;
      host.resize();
    }
  }

  async function refresh() {
    const list = await Bridge.shelfList();
    if (list) setItems(list);
  }

  function setItems(list: ShelfItem[]) {
    items = [...list].sort((a, b) => b.modified - a.modified);
    if (shown) render();
  }

  render();
  void refresh();

  return {
    id: "shelf",
    el,
    show() {
      if (shown) return;
      shown = true;
      render();
      unlisten = listenWhile<ShelfItem[]>("shelf-changed", (list) => setItems(list));
      void refresh();
    },
    hide() {
      if (!shown) return;
      shown = false;
      unlisten?.();
      unlisten = null;
      press = null;
      if (!dragging) hold.set(false);
      observer?.disconnect();
      observer = null;
      // Tiles still waiting to be seen are rebuilt (and observed again) on the next show.
      for (const [name, view] of tiles) if (view.observed) tiles.delete(name);
    },
    height: () => shelfHeight(items.length),
  };
}

/** Tests: the thumbnail cache. */
export function _shelfThumbCache() {
  return thumbCache;
}
