// The PDF editor, drawn over the Pod window while it is open (pdfstudio.rs
// holds the files). Pages show as a grid of thumbnails: drag one to move it,
// or use the keyboard; turn or remove it from its buttons. "Save PDF" writes
// the pages, in order, as one PDF on the shelf and closes the editor; the
// island shows what was saved.

import "./studio.css";
import { invoke } from "@tauri-apps/api/core";
import { onEvent } from "../core/bridge";
import { h, clear } from "../views/dom";
import { icon } from "../hub/ui";
import { t, tn } from "../i18n/i18n";
import {
  columns, defaultName, move, newPages, saveOrder, slotAt, turn, turnScale,
  type Slot, type StudioPage, type StudioState,
} from "./order";

/** Thumbnails asked for, on the long side (sharp on a 2× screen). */
const THUMB_PX = 360;
/** Thumbnails drawn at once. */
const THUMB_WORKERS = 2;
/** The pointer travels this far before a press becomes a drag. */
const DRAG_START = 5;
const UNDO_MS = 5000;
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface WebView2Bridge {
  postMessageWithAdditionalObjects(message: unknown, objects: ArrayLike<unknown>): void;
}

class Studio {
  private session = -1;
  private seen = new Set<number>();
  private pages: StudioPage[] = [];
  private saving = false;
  private nameEdited = false;

  private root = h("div", { class: "studio", role: "dialog", "aria-modal": "true", "aria-labelledby": "studio-heading", hidden: true });
  private nameInput = h("input", { class: "studio-name", type: "text", spellcheck: "false", "aria-label": t("File name") });
  private count = h("div", { class: "studio-count" });
  private grid = h("div", { class: "studio-grid", role: "listbox", "aria-label": t("Pages"), "aria-orientation": "horizontal" });
  private scroller = h("div", { class: "studio-scroll" }, this.grid);
  private empty = h("div", { class: "studio-empty" });
  private dropCover = h("div", { class: "studio-dropcover", "aria-hidden": "true" });
  private toast = h("div", { class: "studio-toast", role: "status", "aria-live": "polite" });
  private live = h("div", { class: "studio-live", "aria-live": "polite" });
  private saveButton = h("button", { class: "studio-btn primary", type: "button" });
  private cancelButton = h("button", { class: "studio-btn", type: "button" });
  private addButton = h("button", { class: "studio-btn", type: "button" });

  private cards = new Map<string, HTMLElement>();
  private thumbs = new Map<string, string | null>();
  private queue: StudioPage[] = [];
  private running = 0;
  private observer: IntersectionObserver;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private discardTimer: ReturnType<typeof setTimeout> | null = null;
  private dragDepth = 0;

  constructor() {
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const key = (e.target as HTMLElement).dataset.key ?? "";
        this.observer.unobserve(e.target);
        const page = this.pages.find((p) => p.key === key);
        if (page && !this.thumbs.has(key)) this.want(page);
      }
    }, { root: this.scroller, rootMargin: "300px 0px" });
    this.build();
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  private build() {
    const title = h("div", { class: "studio-title" },
      h("h1", { id: "studio-heading", class: "studio-heading", text: t("PDF editor") }),
      h("div", { class: "studio-file" }, this.nameInput, h("span", { class: "studio-ext", text: ".pdf" })),
      this.count,
    );
    this.addButton.append(icon("plus"), h("span", { text: t("Add files") }));
    this.cancelButton.textContent = t("Cancel");
    this.saveButton.append(h("span", { class: "studio-spin", "aria-hidden": "true" }), h("span", { class: "label", text: t("Save PDF") }));
    const bar = h("header", { class: "studio-bar" }, title, h("div", { class: "studio-actions" }, this.addButton, this.cancelButton, this.saveButton));
    const hint = h("div", { class: "studio-hint", text: t("Drag pages to put them in order. Keys: arrows to move between pages, Alt + arrows to move a page, R to turn it, Delete to remove it.") });
    this.empty.append(
      h("div", { class: "studio-empty-art", "aria-hidden": "true" }, h("span"), h("span"), h("span")),
      h("div", { class: "studio-empty-title", text: t("No pages yet") }),
      h("div", { class: "studio-empty-text", text: t("Drop pictures or PDFs here, or add them from a folder.") }),
    );
    const addAgain = h("button", { class: "studio-btn", type: "button", onclick: () => void this.pick() });
    addAgain.append(icon("plus"), h("span", { text: t("Add files") }));
    this.empty.append(addAgain);
    this.dropCover.append(h("div", { class: "studio-dropcover-card" }, icon("download"), h("span", { text: t("Drop to add pages") })));
    this.root.append(bar, hint, this.scroller, this.empty, this.dropCover, this.toast, this.live);
    document.body.append(this.root);

    this.addButton.addEventListener("click", () => void this.pick());
    this.cancelButton.addEventListener("click", () => this.cancel());
    this.saveButton.addEventListener("click", () => void this.save());
    this.nameInput.addEventListener("input", () => (this.nameEdited = true));
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.save();
    });
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    this.grid.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.installDrop();
  }

  private get isOpen() {
    return !this.root.hidden;
  }

  private show() {
    if (this.isOpen) return;
    this.root.hidden = false;
    this.root.classList.remove("leaving");
    document.body.classList.add("studio-on");
    requestAnimationFrame(() => (this.pages[0] ? this.cards.get(this.pages[0].key)?.focus() : this.addButton.focus()));
  }

  private hide() {
    if (!this.isOpen) return;
    const done = () => {
      this.root.hidden = true;
      this.root.classList.remove("leaving");
      document.body.classList.remove("studio-on");
      this.reset();
    };
    if (reducedMotion()) return done();
    this.root.classList.add("leaving");
    setTimeout(done, 160);
  }

  private reset() {
    this.session = -1;
    this.seen.clear();
    this.pages = [];
    this.thumbs.clear();
    this.queue = [];
    this.nameEdited = false;
    this.saving = false;
    this.setSaving(false);
    for (const card of this.cards.values()) this.observer.unobserve(card);
    this.cards.clear();
    clear(this.grid);
  }

  // ── What the editor holds ─────────────────────────────────────────────────

  /** pdfstudio.rs says what it holds: a new session starts over, else new files are added. */
  apply(state: StudioState) {
    if (state.session !== this.session) {
      this.reset();
      this.session = state.session;
    }
    const added = newPages(state, this.seen);
    for (const s of state.sources) this.seen.add(s.id);
    if (added.length > 0) {
      this.pages = [...this.pages, ...added];
      this.render();
      if (this.isOpen && state.failed.length === 0) {
        this.say(tn("Added {count} page", "Added {count} pages", added.length, { count: added.length }));
      }
    }
    if (!this.nameEdited) this.nameInput.value = defaultName(state.sources);
    if (state.failed.length > 0) {
      const first = state.failed[0];
      const more = state.failed.length - 1;
      this.notify(more > 0
        ? t("Couldn't add {name} and {count} more: {error}", { name: first.name, count: more, error: first.error })
        : t("Couldn't add {name}: {error}", { name: first.name, error: first.error }));
    }
    this.show();
    this.update();
  }

  private async pick() {
    try {
      const state = await invoke<StudioState | null>("pdf_studio_pick");
      if (state) this.apply(state);
    } catch (err) {
      this.notify(String(err));
    }
  }

  // ── Grid ───────────────────────────────────────────────────────────────────

  private render() {
    const keep = new Set(this.pages.map((p) => p.key));
    for (const [key, card] of this.cards) {
      if (!keep.has(key)) {
        this.observer.unobserve(card);
        card.remove();
        this.cards.delete(key);
      }
    }
    this.pages.forEach((page, i) => {
      let card = this.cards.get(page.key);
      if (!card) {
        card = this.card(page);
        this.cards.set(page.key, card);
        this.observer.observe(card);
      }
      this.label(card, page, i);
      if (this.grid.children[i] !== card) this.grid.insertBefore(card, this.grid.children[i] ?? null);
    });
    this.update();
  }

  private card(page: StudioPage): HTMLElement {
    const paper = h("div", { class: "studio-paper" }, h("span", { class: "studio-paper-num" }));
    paper.style.setProperty("--ratio", `${page.w} / ${page.h}`);
    paper.style.setProperty("--ratio-n", String(page.w / page.h));
    const sheet = h("div", { class: "studio-sheet" }, paper);
    const tools = h("div", { class: "studio-tools" },
      this.tool("rotateLeft", t("Turn left"), () => this.turnPage(page.key, -1)),
      this.tool("rotateRight", t("Turn right"), () => this.turnPage(page.key, 1)),
      this.tool("x", t("Remove page"), () => this.remove(page.key), "danger"),
    );
    const meta = h("div", { class: "studio-meta" }, h("span", { class: "studio-num" }), h("span", { class: "studio-src" }));
    const card = h("div", { class: "studio-page", role: "option", tabindex: "-1", "data-key": page.key }, sheet, tools, meta);
    this.applyTurn(card, page, false);
    const url = this.thumbs.get(page.key);
    if (url) this.setThumb(card, url);
    return card;
  }

  private tool(name: string, title: string, onclick: () => void, tone = ""): HTMLElement {
    const b = h("button", { class: `studio-tool ${tone}`, type: "button", title, "aria-label": title, tabindex: "-1" });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onclick();
    });
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.append(name === "rotateLeft" || name === "rotateRight" ? turnIcon(name === "rotateLeft") : icon(name));
    return b;
  }

  private label(card: HTMLElement, page: StudioPage, i: number) {
    const n = this.pages.length;
    const where = page.kind === "pdf" ? t("{name}, page {page}", { name: page.name, page: page.page + 1 }) : page.name;
    card.setAttribute("aria-label", t("Page {index} of {count}: {source}", { index: i + 1, count: n, source: where }));
    card.setAttribute("aria-posinset", String(i + 1));
    card.setAttribute("aria-setsize", String(n));
    (card.querySelector(".studio-num") as HTMLElement).textContent = String(i + 1);
    (card.querySelector(".studio-src") as HTMLElement).textContent = page.kind === "pdf" ? `${page.name} · ${page.page + 1}` : page.name;
    (card.querySelector(".studio-paper-num") as HTMLElement).textContent = String(page.page + 1);
  }

  private applyTurn(card: HTMLElement, page: StudioPage, animate: boolean) {
    const paper = card.querySelector(".studio-paper") as HTMLElement;
    paper.style.transition = animate && !reducedMotion() ? `transform 260ms ${EASE_OUT}` : "none";
    paper.style.transform = `rotate(${page.turns * 90}deg) scale(${turnScale(page.w, page.h, page.turns)})`;
    card.dataset.turns = String(page.turns);
  }

  /** Header, counts and the empty state follow the pages. */
  private update() {
    const n = this.pages.length;
    this.count.textContent = tn("{count} page", "{count} pages", n, { count: n });
    this.empty.hidden = n > 0;
    this.scroller.hidden = n === 0;
    this.saveButton.disabled = n === 0 || this.saving;
    // One page is reachable with Tab; the arrows move between them.
    const focused = this.focusedIndex();
    this.pages.forEach((p, i) => this.cards.get(p.key)?.setAttribute("tabindex", i === Math.max(0, focused) ? "0" : "-1"));
  }

  private focusedIndex(): number {
    const key = (document.activeElement as HTMLElement | null)?.closest?.(".studio-page")?.getAttribute("data-key");
    return key ? this.pages.findIndex((p) => p.key === key) : -1;
  }

  private focusAt(i: number) {
    const page = this.pages[Math.max(0, Math.min(i, this.pages.length - 1))];
    if (!page) return this.addButton.focus();
    const card = this.cards.get(page.key);
    if (!card) return;
    for (const c of this.cards.values()) c.setAttribute("tabindex", c === card ? "0" : "-1");
    card.focus();
    card.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  }

  // ── Thumbnails ─────────────────────────────────────────────────────────────

  private want(page: StudioPage) {
    if (this.queue.some((p) => p.key === page.key)) return;
    this.queue.push(page);
    this.pump();
  }

  private pump() {
    while (this.running < THUMB_WORKERS && this.queue.length > 0) {
      const page = this.queue.shift()!;
      const session = this.session;
      this.running++;
      invoke<string | null>("pdf_studio_thumb", { source: page.source, page: page.page, size: THUMB_PX })
        .catch(() => null)
        .then((url) => {
          if (session !== this.session) return;
          this.thumbs.set(page.key, url);
          const card = this.cards.get(page.key);
          if (card && url) this.setThumb(card, url);
        })
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  private setThumb(card: HTMLElement, url: string) {
    const paper = card.querySelector(".studio-paper") as HTMLElement;
    if (paper.querySelector("img")) return;
    const img = h("img", { class: "studio-thumb", alt: "", draggable: "false", decoding: "async" });
    img.addEventListener("load", () => paper.classList.add("drawn"), { once: true });
    img.src = url;
    paper.append(img);
  }

  // ── Editing ────────────────────────────────────────────────────────────────

  private turnPage(key: string, by: number) {
    const i = this.pages.findIndex((p) => p.key === key);
    if (i < 0) return;
    const page = turn(this.pages[i], by);
    this.pages[i] = page;
    const card = this.cards.get(key);
    if (card) {
      // The turn animates from where it is, so turning on and on keeps spinning the same way.
      const paper = card.querySelector(".studio-paper") as HTMLElement;
      const from = Number(card.dataset.spin ?? page.turns - by);
      const to = from + by;
      card.dataset.spin = String(to);
      card.dataset.turns = String(page.turns);
      paper.style.transition = reducedMotion() ? "none" : `transform 260ms ${EASE_OUT}`;
      paper.style.transform = `rotate(${to * 90}deg) scale(${turnScale(page.w, page.h, page.turns)})`;
    }
    this.say(t("Page {index} turned", { index: i + 1 }));
  }

  private remove(key: string) {
    const i = this.pages.findIndex((p) => p.key === key);
    if (i < 0) return;
    const page = this.pages[i];
    const hadFocus = this.focusedIndex() === i;
    const before = this.rects();
    this.pages = this.pages.filter((p) => p.key !== key);
    this.render();
    this.flip(before);
    if (hadFocus || this.pages.length === 0) this.focusAt(i);
    this.notify(t("Page {index} removed", { index: i + 1 }), t("Undo"), () => {
      const before = this.rects();
      this.pages = move([...this.pages, page], this.pages.length, i);
      this.render();
      this.flip(before);
      this.focusAt(i);
    });
  }

  private moveTo(from: number, to: number, focus = true) {
    to = Math.max(0, Math.min(to, this.pages.length - 1));
    if (from === to) return;
    const before = this.rects();
    this.pages = move(this.pages, from, to);
    this.render();
    this.flip(before);
    if (focus) this.focusAt(to);
    this.say(t("Moved to position {index} of {count}", { index: to + 1, count: this.pages.length }));
  }

  // ── Moving cards: FLIP ─────────────────────────────────────────────────────

  private rects(): Map<string, DOMRect> {
    const out = new Map<string, DOMRect>();
    for (const [key, card] of this.cards) out.set(key, card.getBoundingClientRect());
    return out;
  }

  /** Cards slide from where they were to where they are now. */
  private flip(before: Map<string, DOMRect>, skip?: string) {
    if (reducedMotion()) return;
    for (const [key, card] of this.cards) {
      if (key === skip) continue;
      const was = before.get(key);
      if (!was) continue;
      const now = card.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      card.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: 220, easing: EASE_OUT },
      );
    }
  }

  // ── Dragging a page ────────────────────────────────────────────────────────

  private onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || this.saving) return;
    const card = (e.target as HTMLElement).closest(".studio-page") as HTMLElement | null;
    if (!card) return;
    const key = card.dataset.key!;
    const startX = e.clientX;
    const startY = e.clientY;
    const startIndex = this.pages.findIndex((p) => p.key === key);
    const original = this.pages.slice();
    let dragging = false;
    let slots: Slot[] = [];
    let grab = { x: 0, y: 0 };
    let pointer = { x: startX, y: startY };
    let scrollFrame = 0;
    card.focus({ preventScroll: true });

    const toContent = (x: number, y: number) => {
      const box = this.grid.getBoundingClientRect();
      return { x: x - box.left, y: y - box.top };
    };
    const place = () => {
      const index = this.pages.findIndex((p) => p.key === key);
      const slot = slots[index];
      const at = toContent(pointer.x, pointer.y);
      card.style.transform = `translate(${at.x - grab.x - slot.x}px, ${at.y - grab.y - slot.y}px) scale(1.04)`;
    };
    const retarget = () => {
      const at = toContent(pointer.x, pointer.y);
      const from = this.pages.findIndex((p) => p.key === key);
      const to = slotAt(slots, at.x, at.y);
      if (to >= 0 && to !== from) {
        const before = this.rects();
        this.pages = move(this.pages, from, to);
        this.render();
        this.flip(before, key);
      }
      place();
    };
    // Near the top or bottom edge, the grid scrolls on its own.
    const autoScroll = () => {
      scrollFrame = 0;
      if (!dragging) return;
      const box = this.scroller.getBoundingClientRect();
      const edge = 56;
      const speed = pointer.y < box.top + edge ? -(box.top + edge - pointer.y) : pointer.y > box.bottom - edge ? pointer.y - (box.bottom - edge) : 0;
      if (speed !== 0) {
        const before = this.scroller.scrollTop;
        this.scroller.scrollTop += Math.max(-24, Math.min(24, speed / 3));
        if (this.scroller.scrollTop !== before) retarget();
        scrollFrame = requestAnimationFrame(autoScroll);
      }
    };
    const begin = () => {
      dragging = true;
      const box = this.grid.getBoundingClientRect();
      slots = this.pages.map((p) => {
        const r = this.cards.get(p.key)!.getBoundingClientRect();
        return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
      });
      const r = card.getBoundingClientRect();
      grab = { x: startX - r.left, y: startY - r.top };
      card.classList.add("lifted");
      this.root.classList.add("dragging");
      card.setPointerCapture(e.pointerId);
    };
    const onMove = (ev: PointerEvent) => {
      pointer = { x: ev.clientX, y: ev.clientY };
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_START) return;
        begin();
      }
      retarget();
      if (!scrollFrame) scrollFrame = requestAnimationFrame(autoScroll);
    };
    const end = (cancelled: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onEscape, true);
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      if (!dragging) return;
      dragging = false;
      if (cancelled) {
        const before = this.rects();
        this.pages = original;
        this.render();
        this.flip(before, key);
      }
      // The card settles into its slot from where it was let go.
      const was = card.getBoundingClientRect();
      card.style.transform = "";
      card.classList.remove("lifted");
      this.root.classList.remove("dragging");
      const now = card.getBoundingClientRect();
      if (!reducedMotion()) {
        card.animate(
          [{ transform: `translate(${was.left - now.left}px, ${was.top - now.top}px) scale(1.04)` }, { transform: "none" }],
          { duration: 200, easing: EASE_OUT },
        );
      }
      const index = this.pages.findIndex((p) => p.key === key);
      this.focusAt(index);
      if (cancelled) this.say(t("Move cancelled"));
      else if (index !== startIndex) this.say(t("Moved to position {index} of {count}", { index: index + 1, count: this.pages.length }));
    };
    const onUp = () => end(false);
    const onCancel = () => end(true);
    const onEscape = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && dragging) {
        ev.preventDefault();
        ev.stopPropagation();
        end(true);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onEscape, true);
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  private onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void this.save();
      return;
    }
    const i = this.focusedIndex();
    if (i < 0 || this.saving) return;
    const cols = columns(this.slotsNow());
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols };
    const rtl = getComputedStyle(this.grid).direction === "rtl";
    let delta = step[e.key];
    if (delta !== undefined && rtl && (e.key === "ArrowLeft" || e.key === "ArrowRight")) delta = -delta;
    if (delta !== undefined) {
      e.preventDefault();
      if (e.altKey || e.ctrlKey) this.moveTo(i, i + delta);
      else this.focusAt(i + delta);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const to = e.key === "Home" ? 0 : this.pages.length - 1;
      if (e.altKey || e.ctrlKey) this.moveTo(i, to);
      else this.focusAt(to);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      this.remove(this.pages[i].key);
    } else if (e.key.toLowerCase() === "r" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      this.turnPage(this.pages[i].key, e.shiftKey ? -1 : 1);
    }
  }

  private slotsNow(): Slot[] {
    return this.pages.map((p) => {
      const r = this.cards.get(p.key)!.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
  }

  // ── Files dropped on the editor ────────────────────────────────────────────

  private installDrop() {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
    window.addEventListener("dragenter", (e) => {
      if (!this.isOpen || !hasFiles(e)) return;
      e.preventDefault();
      this.dragDepth++;
      this.root.classList.add("over");
    });
    window.addEventListener("dragover", (e) => {
      if (!this.isOpen || !hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    window.addEventListener("dragleave", () => {
      if (!this.isOpen) return;
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) this.root.classList.remove("over");
    });
    window.addEventListener("drop", (e) => {
      if (!this.isOpen) return;
      e.preventDefault();
      this.dragDepth = 0;
      this.root.classList.remove("over");
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      // WebView2 hands the files to Rust with their paths (webview_drop.rs);
      // elsewhere Tauri's own drop event has already given them.
      const webview = (window as unknown as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview;
      webview?.postMessageWithAdditionalObjects("pod-file-drop", files);
    });
  }

  // ── Save, cancel ───────────────────────────────────────────────────────────

  private setSaving(on: boolean) {
    this.saving = on;
    this.root.classList.toggle("saving", on);
    this.saveButton.disabled = on || this.pages.length === 0;
    this.addButton.disabled = on;
    this.cancelButton.disabled = on;
    this.nameInput.disabled = on;
    (this.saveButton.querySelector(".label") as HTMLElement).textContent = on ? t("Saving…") : t("Save PDF");
  }

  private async save() {
    if (this.saving || this.pages.length === 0) return;
    this.setSaving(true);
    try {
      await invoke<string>("pdf_studio_save", { pages: saveOrder(this.pages), name: this.nameInput.value });
      // pdfstudio.rs closes the editor ("pdf-studio-closed"); the island shows the file.
    } catch (err) {
      this.setSaving(false);
      this.notify(t("Couldn't save the PDF: {error}", { error: String(err).replace(/^Error:\s*/, "") }));
    }
  }

  /** Cancel asks once more when there are pages to lose. */
  private cancel() {
    if (this.pages.length > 0 && !this.cancelButton.classList.contains("confirm")) {
      this.cancelButton.classList.add("confirm");
      this.cancelButton.textContent = t("Discard pages?");
      if (this.discardTimer) clearTimeout(this.discardTimer);
      this.discardTimer = setTimeout(() => {
        this.cancelButton.classList.remove("confirm");
        this.cancelButton.textContent = t("Cancel");
      }, 3000);
      return;
    }
    if (this.discardTimer) clearTimeout(this.discardTimer);
    this.cancelButton.classList.remove("confirm");
    this.cancelButton.textContent = t("Cancel");
    void invoke("pdf_studio_close").catch(() => {});
    this.hide();
  }

  closed() {
    this.hide();
  }

  // ── Telling the user ───────────────────────────────────────────────────────

  /** A screen reader hears it; nothing shows. */
  private say(text: string) {
    this.live.textContent = "";
    requestAnimationFrame(() => (this.live.textContent = text));
  }

  /** A short message at the bottom, with an action when given. */
  private notify(text: string, action?: string, onAction?: () => void) {
    clear(this.toast);
    this.toast.append(h("span", { class: "text", text }));
    if (action && onAction) {
      const b = h("button", { class: "studio-toast-action", type: "button", text: action });
      b.addEventListener("click", () => {
        this.toast.classList.remove("on");
        onAction();
      });
      this.toast.append(b);
    }
    this.toast.classList.add("on");
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.remove("on"), action ? UNDO_MS : 4500);
  }
}

/** A circular arrow, turning left or right. */
function turnIcon(left: boolean): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M19 12a7 7 0 1 1-2.05-4.95M19 4.5V9h-4.5");
  if (left) svg.style.transform = "scaleX(-1)";
  svg.append(path);
  return svg;
}

/** Puts the editor in the Pod window; it shows when pdfstudio.rs opens it. */
export function installStudio() {
  let studio: Studio | null = null;
  const get = () => (studio ??= new Studio());
  void onEvent<StudioState>("pdf-studio", (state) => get().apply(state));
  void onEvent<null>("pdf-studio-closed", () => studio?.closed());
  // Opened before this page was ready: catch up.
  void invoke<StudioState | null>("pdf_studio_state").then((state) => {
    if (state) get().apply(state);
  }).catch(() => {});
}
