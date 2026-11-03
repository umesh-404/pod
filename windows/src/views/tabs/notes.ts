// The Notes tab: a quick note that saves itself to the shelf as Markdown.
// The first save creates the file (Rust names it), the next ones rewrite it.
// Below, the recent notes: the shelf's .md files, newest first. Deleting a note
// moves its file to the Recycle Bin (shelf_remove), never deletes it for good.

import { Bridge, type ShelfItem } from "../../core/bridge";
import { h, svg } from "../dom";
import { t, tl } from "../../i18n/i18n";
import { GLYPHS } from "./glyphs";
import { clampHeight, formatAge, holder, listenWhile, middleEllipsis } from "./common";
import type { Tab, TabHost } from "./tab";

const SAVE_DEBOUNCE = 800;
const RECENT_MAX = 8;
const HEIGHT = 268;

type Status = "idle" | "editing" | "saving" | "saved" | "error";

/** The shelf's notes, newest first. */
export function recentNotes(items: ShelfItem[], max = RECENT_MAX): ShelfItem[] {
  return items
    .filter((i) => !i.isDir && i.ext.toLowerCase() === "md")
    .sort((a, b) => b.modified - a.modified)
    .slice(0, max);
}

export function notesTab(host: TabHost): Tab {
  const hold = holder(host);
  let shown = false;
  let current: string | null = null;
  let dirty = false;
  let saving: Promise<void> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let notes: ShelfItem[] = [];
  let unlisten: (() => void) | null = null;
  let switching = false;

  const statusDot = h("i", { class: "note-status-dot" });
  const statusText = h("span", { class: "note-status-text" });
  const status = h("div", { class: "note-status", "aria-live": "polite" }, statusDot, statusText);
  const newBtn = h(
    "button",
    { class: "tab-link", onclick: () => void newNote() },
    svg(GLYPHS.compose, 12, { stroke: 1.8 }),
    h("span", { text: tl("New note") }),
  );
  const deleteBtn = h(
    "button",
    { class: "tab-link note-delete", title: tl("Move to Recycle Bin"), onclick: () => void deleteNote() },
    svg(GLYPHS.trash, 12, { stroke: 1.8 }),
    h("span", { text: tl("Delete") }),
  );
  const actions = h("div", { class: "tab-head-actions" }, deleteBtn, newBtn);
  const head = h("div", { class: "tab-head" }, status, actions);
  const area = h("textarea", {
    class: "note-area",
    placeholder: tl("Write a note…"),
    "aria-label": tl("Note"),
    spellcheck: "true",
  });
  area.value = "";
  const strip = h("div", { class: "note-strip", role: "list" });
  const el = h("div", { class: "tab-view tab-notes" }, head, area, strip);

  function setStatus(s: Status) {
    status.className = `note-status ${s}`;
    const text =
      s === "saving" ? t("Saving…") : s === "saved" ? t("Saved to shelf") : s === "error" ? t("Couldn't save") : s === "editing" ? t("Editing") : "";
    if (statusText.textContent !== text) statusText.textContent = text;
  }

  // ── Saving ─────────────────────────────────────────────────────────────────

  function scheduleSave() {
    dirty = true;
    setStatus("editing");
    if (saveTimer != null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flush();
    }, SAVE_DEBOUNCE);
  }

  /** Writes what is in the editor now, after any save already on its way. */
  async function flush(): Promise<void> {
    if (saveTimer != null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    while (saving) await saving;
    if (!dirty) return;
    const text = area.value;
    // An empty new note is not worth a file.
    if (current == null && !text.trim()) {
      dirty = false;
      setStatus("idle");
      return;
    }
    dirty = false;
    setStatus("saving");
    saving = Bridge.noteSave(current, text)
      .then((name) => {
        if (name) current = name;
        if (!dirty) setStatus("saved");
        paintStrip();
      })
      .catch(() => {
        dirty = true;
        setStatus("error");
      })
      .finally(() => {
        saving = null;
      });
    await saving;
  }

  area.addEventListener("input", () => scheduleSave());
  area.addEventListener("blur", () => {
    hold.set(false);
    void flush();
  });

  // ── Switching notes ────────────────────────────────────────────────────────

  async function newNote() {
    if (switching) return;
    switching = true;
    try {
      await flush();
      // The save failed: what is in the editor stays, rather than being wiped.
      if (dirty) {
        host.sound("error");
        return;
      }
      current = null;
      area.value = "";
      setStatus("idle");
      paintStrip();
      area.focus();
    } finally {
      switching = false;
    }
  }

  async function openNote(name: string) {
    if (switching || name === current) return;
    switching = true;
    try {
      await flush();
      // The save failed: opening another note would throw the unsaved text away.
      if (dirty) {
        host.sound("error");
        return;
      }
      const text = await Bridge.noteRead(name);
      current = name;
      area.value = text ?? "";
      dirty = false;
      setStatus("idle");
      paintStrip();
      area.focus();
    } catch {
      host.sound("error");
    } finally {
      switching = false;
    }
  }

  async function deleteNote() {
    if (switching || current == null) return;
    switching = true;
    try {
      // What is still being typed belongs to the note going away: drop it.
      if (saveTimer != null) clearTimeout(saveTimer);
      saveTimer = null;
      while (saving) await saving;
      const name = current;
      await Bridge.shelfRemove([name]);
      current = null;
      dirty = false;
      area.value = "";
      notes = notes.filter((n) => n.name !== name);
      setStatus("idle");
      paintStrip();
      host.sound("pop");
      void refresh();
    } catch {
      host.sound("error");
    } finally {
      switching = false;
    }
  }

  // ── Recent notes ───────────────────────────────────────────────────────────

  function paintStrip() {
    const chips = notes.map((n) => {
      const title = n.name.replace(/\.md$/i, "");
      return h(
        "button",
        {
          class: `note-chip${n.name === current ? " on" : ""}`,
          role: "listitem",
          title: n.name,
          onclick: () => void openNote(n.name),
        },
        h("span", { class: "note-chip-name", text: middleEllipsis(title, 18) }),
        h("span", { class: "note-chip-age", text: formatAge(n.modified) }),
      );
    });
    strip.replaceChildren(...chips);
    deleteBtn.hidden = current == null;
    el.classList.toggle("no-recent", chips.length === 0);
  }

  function setShelf(items: ShelfItem[]) {
    notes = recentNotes(items);
    if (shown) paintStrip();
  }

  async function refresh() {
    const items = await Bridge.shelfList();
    if (items) setShelf(items);
  }

  setStatus("idle");
  paintStrip();

  // A shortcut opened this tab for something in particular (island/tabs.ts, TAB_INTENT_EVENT).
  window.addEventListener?.("pod-tab-intent", ((e: CustomEvent<{ tab: string; intent: string }>) => {
    if (e.detail?.tab === "notes" && e.detail.intent === "new") void newNote();
  }) as EventListener);

  return {
    id: "notes",
    el,
    show() {
      if (shown) return;
      shown = true;
      paintStrip();
      unlisten = listenWhile<ShelfItem[]>("shelf-changed", (items) => setShelf(items));
      void refresh();
    },
    hide() {
      if (!shown) return;
      shown = false;
      unlisten?.();
      unlisten = null;
      hold.set(false);
      // Nothing typed is lost when the island folds.
      void flush();
    },
    height: () => clampHeight(HEIGHT),
  };
}
