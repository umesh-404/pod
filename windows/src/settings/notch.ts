// Settings → Notch: a live preview of the compact notch, what each of its two
// sides shows and in which order (`leftWidgets`, `rightWidgets`, `leftOff`,
// `rightOff`, `leftRotateSeconds`, `rotateSeconds`), the calendar links
// behind "Next meeting" (`calendarUrls`), and the focus timer's lengths
// (`focusMinutes`, `breakMinutes`).
//
// The two sides are two lists of the same items: drag a row by its handle to
// reorder it or to move it to the other side (or use the arrow keys on the
// handle, or the arrow button), and switch it on or off. Every change shows in
// the preview at once.

import { Bridge } from "../core/bridge";
import { h, clear, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { t, tn } from "../i18n/i18n";
import { anchor, toggle } from "../hub/ui";
import {
  BREAK_RANGE, FOCUS_RANGE, ROTATE_RANGE, SIDE_ICONS, SIDE_ITEMS, calendarLink, clampNumber, placeRow, sideRows,
  sideSettingsKeeping, type RightRow, type Side,
} from "./catalog";
import { NotchPreview } from "./notch-preview";
import type { SettingsAccess } from "./access";

const errText = (err: unknown) => String(err).replace(/^Error:\s*/, "");

/** A long link keeps its start and its end; the full one is in the tooltip. */
function shortLink(url: string, max = 60): string {
  if (url.length <= max) return url;
  const head = Math.ceil((max - 1) * 0.6);
  return `${url.slice(0, head)}…${url.slice(url.length - (max - 1 - head))}`;
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

function numberField(value: number, range: { min: number; max: number }, onChange: (n: number) => void): HTMLInputElement {
  const el = h("input", {
    type: "number", min: String(range.min), max: String(range.max), step: "1",
    value: String(value), style: "width:72px",
  }) as HTMLInputElement;
  el.addEventListener("change", () => {
    const n = clampNumber(el.value, range, value);
    el.value = String(n);
    value = n;
    onChange(n);
  });
  return el;
}

/** A small stroke icon on a 24×24 grid. */
function strokeIcon(d: string, size = 14, stroke = 1.9): SVGSVGElement {
  return svg(d, size, { stroke });
}

const GRIP = "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01";
const ARROW: Record<Side, string> = { left: "M19 12H5M11 6l-6 6 6 6", right: "M5 12h14M13 6l6 6-6 6" };

// ── Preview and the two sides ─────────────────────────────────────────────────

/** Room between two rows of a side's list, px (settings.css, .side-list gap). */
const ROW_GAP = 6;

interface RowEls {
  row: HTMLElement;
  grip: HTMLButtonElement;
  move: HTMLButtonElement;
}

interface Drag {
  id: string;
  from: Side;
  index: number;
  pointer: number;
  startX: number;
  startY: number;
  /** The dragged row's height and the gap under it. */
  step: number;
  /** Where the dragged row's middle started, y. */
  mid: number;
  lists: Record<Side, DOMRect>;
  /** The other rows of each side, in order, with their middles as if the dragged row were gone. */
  others: Record<Side, { id: string; mid: number }[]>;
  target: { side: Side; index: number };
}

function sidesSections(access: SettingsAccess): HTMLElement[] {
  const preview = new NotchPreview(access.get());
  let rows = sideRows(access.get());
  const els = new Map<string, RowEls>();
  const lists: Record<Side, HTMLElement> = {
    left: h("div", { class: "side-list", role: "list", "data-side": "left" }),
    right: h("div", { class: "side-list", role: "list", "data-side": "right" }),
  };
  const empties: Record<Side, HTMLElement> = {
    left: h("div", { class: "side-empty", text: t("Drag items here") }),
    right: h("div", { class: "side-empty", text: t("Drag items here") }),
  };
  const live = h("div", { class: "sr-only", "aria-live": "polite" });
  const title = (id: string) => t(SIDE_ITEMS.find((i) => i.id === id)?.title ?? id);
  const sideOf = (id: string): Side => (rows.left.some((r) => r.id === id) ? "left" : "right");
  const other = (side: Side): Side => (side === "left" ? "right" : "left");
  const sideName = (side: Side) => (side === "left" ? t("Left side") : t("Right side"));

  function persist() {
    access.set(sideSettingsKeeping(access.get(), rows));
    preview.update(access.get());
  }

  /** Puts the rows in their lists, in order, and the move buttons the right way. */
  function layout() {
    for (const side of ["left", "right"] as Side[]) {
      const list = lists[side];
      list.replaceChildren(...rows[side].map((r) => els.get(r.id)!.row));
      if (rows[side].length === 0) list.append(empties[side]);
      list.classList.toggle("empty", rows[side].length === 0);
      for (const r of rows[side]) {
        const el = els.get(r.id)!;
        const to = other(side);
        el.row.dataset.side = side;
        el.move.replaceChildren(strokeIcon(ARROW[to], 15));
        const label = to === "left" ? t("Move to the left side") : t("Move to the right side");
        el.move.title = label;
        el.move.setAttribute("aria-label", `${title(r.id)}: ${label}`);
      }
    }
  }

  /** Every row's place on screen, transforms included. */
  function places(): Map<HTMLElement, DOMRect> {
    const out = new Map<HTMLElement, DOMRect>();
    for (const { row } of els.values()) out.set(row, row.getBoundingClientRect());
    return out;
  }

  /** Runs `mutate` and slides every row from where it was seen to its new place (FLIP, transforms only). */
  function glide(mutate: () => void, animate = true) {
    const before = animate && !reducedMotion() ? places() : null;
    mutate();
    if (!before) return;
    for (const [row, from] of before) {
      const to = row.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if ((Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) || typeof row.animate !== "function") continue;
      for (const a of row.getAnimations?.() ?? []) a.cancel();
      row.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: 240, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
      );
    }
  }

  function announce(id: string) {
    const side = sideOf(id);
    const index = rows[side].findIndex((r) => r.id === id);
    live.textContent = t("{name}: {side}, position {position} of {count}", {
      name: title(id), side: sideName(side), position: index + 1, count: rows[side].length,
    });
  }

  /** Item `id` to `side` at `index`; `animate` for what the pointer did (keys move at once). */
  function place(id: string, side: Side, index: number | undefined, animate: boolean) {
    const next = placeRow(rows, id, side, index);
    const from = sideOf(id);
    const at = rows[from].findIndex((r) => r.id === id);
    if (from === side && next[side].findIndex((r) => r.id === id) === at) return;
    glide(() => {
      rows = next;
      layout();
    }, animate);
    persist();
    announce(id);
  }

  // Drag by the handle: the row follows the pointer, the others make room.
  let drag: Drag | null = null;

  function startDrag(id: string, e: PointerEvent) {
    const el = els.get(id)!;
    const from = sideOf(id);
    const index = rows[from].findIndex((r) => r.id === id);
    const box = el.row.getBoundingClientRect();
    const step = box.height + ROW_GAP;
    const others = {} as Drag["others"];
    for (const side of ["left", "right"] as Side[]) {
      others[side] = rows[side]
        .filter((r) => r.id !== id)
        .map((r, k) => {
          const b = els.get(r.id)!.row.getBoundingClientRect();
          // Rows under the dragged one move up into its place once it is lifted.
          const lifted = side === from && k >= index ? step : 0;
          return { id: r.id, mid: b.top + b.height / 2 - lifted };
        });
    }
    drag = {
      id, from, index, pointer: e.pointerId, startX: e.clientX, startY: e.clientY, step,
      mid: box.top + box.height / 2,
      lists: { left: lists.left.getBoundingClientRect(), right: lists.right.getBoundingClientRect() },
      others, target: { side: from, index },
    };
    try {
      el.grip.setPointerCapture(e.pointerId);
    } catch { /* the pointer is already gone */ }
    el.row.classList.add("dragging");
    document.body.classList.add("side-dragging");
    window.addEventListener?.("keydown", escape, true);
  }

  /** Esc while dragging puts the row back. */
  function escape(e: KeyboardEvent) {
    if (e.key !== "Escape" || !drag) return;
    e.preventDefault();
    e.stopPropagation();
    endDrag({ pointerId: drag.pointer } as PointerEvent, false);
  }

  /** The side under the pointer: the list it is over, else the nearest. */
  function sideAt(x: number, y: number, d: Drag): Side {
    const dist = (r: DOMRect) => {
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      return Math.hypot(dx, dy);
    };
    return dist(d.lists.left) <= dist(d.lists.right) ? "left" : "right";
  }

  function moveDrag(e: PointerEvent) {
    const d = drag;
    if (!d || e.pointerId !== d.pointer) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const side = sideAt(e.clientX, e.clientY, d);
    const mid = d.mid + dy;
    const index = d.others[side].filter((o) => o.mid < mid).length;
    d.target = { side, index };
    // The others: out of the dragged row's old place, and out of the way of its new one.
    for (const s of ["left", "right"] as Side[]) {
      d.others[s].forEach((o, k) => {
        const was = s === d.from && k >= d.index ? 1 : 0;
        const now = s === side && k >= index ? 1 : 0;
        const row = els.get(o.id)!.row;
        row.style.transform = now === was ? "" : `translateY(${(now - was) * d.step}px)`;
      });
    }
    // A list taking a row from the other side grows by one row while it waits.
    for (const s of ["left", "right"] as Side[]) {
      lists[s].style.paddingBottom = s === side && s !== d.from ? `${d.step}px` : "";
    }
    // In a narrow window the lists are stacked: the one above growing pushes
    // the dragged row's own list down, so the row follows the pointer from
    // where its list is now, not from where it was.
    const from = lists[d.from].getBoundingClientRect();
    const sx = from.left - d.lists[d.from].left;
    const sy = from.top - d.lists[d.from].top;
    els.get(d.id)!.row.style.transform = `translate(${dx - sx}px, ${dy - sy}px) scale(1.02)`;
  }

  function endDrag(e: PointerEvent, drop: boolean) {
    const d = drag;
    if (!d || e.pointerId !== d.pointer) return;
    drag = null;
    window.removeEventListener?.("keydown", escape, true);
    const el = els.get(d.id)!;
    el.row.classList.remove("dragging");
    document.body.classList.remove("side-dragging");
    const clear = () => {
      for (const { row } of els.values()) row.style.transform = "";
      lists.left.style.paddingBottom = "";
      lists.right.style.paddingBottom = "";
    };
    // Every row glides from where it is seen now to its place.
    const moved = drop && (d.target.side !== d.from || d.target.index !== d.index);
    glide(() => {
      for (const { row } of els.values()) row.style.transition = "none";
      clear();
      if (moved) {
        rows = placeRow(rows, d.id, d.target.side, d.target.index);
        layout();
      }
      void lists.left.offsetWidth;
      for (const { row } of els.values()) row.style.transition = "";
    });
    if (moved) {
      persist();
      announce(d.id);
    }
  }

  for (const item of SIDE_ITEMS) {
    const r = [...rows.left, ...rows.right].find((x) => x.id === item.id)!;
    const name = t(item.title);
    const grip = h("button", {
      class: "side-grip",
      title: t("Drag to reorder, or use the arrow keys"),
      "aria-label": `${name}: ${t("Drag to reorder, or use the arrow keys")}`,
    }, strokeIcon(GRIP, 16, 2.6)) as HTMLButtonElement;
    const move = h("button", { class: "hub-icon side-move" }) as HTMLButtonElement;
    const look = SIDE_ICONS[item.id];
    const row = h("div", { class: r.on ? "side-row" : "side-row off", role: "listitem", "data-id": item.id },
      grip,
      h("span", { class: "side-icon" }, look ? svg(ICONS[look.icon as keyof typeof ICONS], 15, { stroke: look.stroke }) : null),
      h("div", { class: "text" },
        h("span", { class: "name", text: name }),
        h("span", { class: "detail", text: t(item.detail) }),
      ),
      move,
    );
    const sw = toggle(r.on, (on) => {
      const side = sideOf(item.id);
      rows = { ...rows, [side]: rows[side].map((x: RightRow) => (x.id === item.id ? { ...x, on } : x)) };
      row.classList.toggle("off", !on);
      persist();
    });
    sw.setAttribute("aria-label", name);
    row.append(sw);
    move.addEventListener("click", () => {
      const to = other(sideOf(item.id));
      const focused = document.activeElement === move;
      place(item.id, to, undefined, true);
      // Moving the row to the other list takes it out of the page for a moment,
      // which drops the focus: a keyboard user stays on the button.
      if (focused) move.focus();
    });
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || drag) return;
      e.preventDefault();
      startDrag(item.id, e);
    });
    grip.addEventListener("pointermove", moveDrag);
    grip.addEventListener("pointerup", (e) => endDrag(e, true));
    grip.addEventListener("pointercancel", (e) => endDrag(e, false));
    grip.addEventListener("lostpointercapture", (e) => endDrag(e, true));
    grip.addEventListener("keydown", (e) => {
      const side = sideOf(item.id);
      const index = rows[side].findIndex((x) => x.id === item.id);
      let target: { side: Side; index: number } | null = null;
      if (drag) return;
      if (e.key === "ArrowUp") target = { side, index: index - 1 };
      else if (e.key === "ArrowDown") target = { side, index: index + 1 };
      else if (e.key === "Home") target = { side, index: 0 };
      else if (e.key === "End") target = { side, index: rows[side].length - 1 };
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const to: Side = e.key === "ArrowLeft" ? "left" : "right";
        if (to !== side) target = { side: to, index: Math.min(index, rows[to].length) };
      }
      if (!target) return;
      e.preventDefault();
      if (target.side === side && (target.index < 0 || target.index >= rows[side].length)) return;
      place(item.id, target.side, target.index, false);
      grip.focus();
    });
    els.set(item.id, { row, grip, move });
  }
  layout();

  const column = (side: Side, seconds: HTMLInputElement) => h("div", { class: "side-col", "data-side": side },
    h("div", { class: "side-head" },
      h("span", { class: `side-mark ${side}`, "aria-hidden": "true" }),
      h("span", { class: "side-title", text: sideName(side) }),
    ),
    lists[side],
    h("div", { class: "side-foot" },
      h("label", { text: t("Seconds per item") }),
      seconds,
    ),
  );
  const leftSeconds = numberField(clampNumber(access.get().leftRotateSeconds, ROTATE_RANGE, 6), ROTATE_RANGE, (n) => {
    access.set({ leftRotateSeconds: n });
    preview.update(access.get());
  });
  const rightSeconds = numberField(clampNumber(access.get().rotateSeconds, ROTATE_RANGE, 6), ROTATE_RANGE, (n) => {
    access.set({ rotateSeconds: n });
    preview.update(access.get());
  });
  leftSeconds.setAttribute("aria-label", `${t("Left side")}: ${t("Seconds per item")}`);
  rightSeconds.setAttribute("aria-label", `${t("Right side")}: ${t("Seconds per item")}`);

  return [
    anchor("notch.preview", h("div", { class: "np-wrap" }, preview.el)),
    anchor("notch.sides", h(
      "section",
      { class: "notch-sides" },
      h("h2", {}, h("span", { text: t("Left and right of the notch") })),
      h("div", { class: "hint", text: t("Drag an item by its handle to reorder it or move it to the other side. The items switched on take turns; one with nothing to show is skipped.") }),
      h("div", { class: "side-columns" }, column("left", leftSeconds), column("right", rightSeconds)),
      live,
    )),
  ];
}

// ── Calendar links ────────────────────────────────────────────────────────────

function calendarSection(access: SettingsAccess): HTMLElement {
  const list = h("div", { class: "notch-list" });
  const feedback = h("div", { class: "feedback" });
  /** The last test of each link, kept while the page is open. */
  const results = new Map<string, { ok: boolean; text: string } | "testing">();

  const input = h("input", {
    type: "text",
    placeholder: t("Paste a calendar link"),
    spellcheck: "false",
    style: "flex:1 1 220px;min-width:0",
  }) as HTMLInputElement;

  const urls = () => access.get().calendarUrls ?? [];

  async function test(url: string) {
    results.set(url, "testing");
    draw();
    try {
      const n = await Bridge.calendarTest(url);
      results.set(url, { ok: true, text: tn("{count} event found", "{count} events found", n) });
    } catch (err) {
      results.set(url, { ok: false, text: errText(err) });
    }
    draw();
  }

  function add() {
    clear(feedback);
    const url = calendarLink(input.value);
    if (!url) {
      feedback.append(h("div", { class: "notice warn", text: t("Paste an http, https or webcal link.") }));
      return;
    }
    if (urls().includes(url)) {
      feedback.append(h("div", { class: "notice warn", text: t("This link is already in the list.") }));
      return;
    }
    access.set({ calendarUrls: [...urls(), url] });
    input.value = "";
    void test(url);
  }

  function remove(url: string) {
    results.delete(url);
    access.set({ calendarUrls: urls().filter((u) => u !== url) });
    draw();
  }

  function draw() {
    clear(list);
    const all = urls();
    if (all.length === 0) {
      list.append(h("div", { class: "hint", text: t("No calendar link yet.") }));
      return;
    }
    for (const url of all) {
      const result = results.get(url);
      const testing = result === "testing";
      const testBtn = h("button", { text: t("Test"), onclick: () => void test(url) }) as HTMLButtonElement;
      testBtn.disabled = testing;
      const status = testing
        ? h("span", { class: "tag", text: t("Testing…") })
        : result
          ? h("span", { class: result.ok ? "tag ok" : "tag err", text: result.text, title: result.text })
          : null;
      list.append(h("div", { class: "notch-row calendar" },
        h("span", { class: "path", text: shortLink(url), title: url }),
        ...(status ? [status] : []),
        testBtn,
        h("button", { class: "danger", text: t("Remove"), onclick: () => remove(url) }),
      ));
    }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") add();
  });
  draw();

  return anchor("notch.calendar", h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Calendar links") })),
    h("div", { class: "hint", text: t("Paste an .ics or webcal link from Outlook, Google Calendar or iCloud to see your next meeting in the notch.") }),
    list,
    h("div", { class: "row" }, input, h("button", { text: t("Add"), onclick: add })),
    feedback,
    h("div", { class: "hint", text: t("The links are fetched only from this computer, and never sent anywhere else.") }),
  ));
}

// ── Focus timer ───────────────────────────────────────────────────────────────

function focusSection(access: SettingsAccess): HTMLElement {
  const s = access.get();
  const focus = numberField(clampNumber(s.focusMinutes, FOCUS_RANGE, 25), FOCUS_RANGE, (n) => access.set({ focusMinutes: n }));
  const rest = numberField(clampNumber(s.breakMinutes, BREAK_RANGE, 5), BREAK_RANGE, (n) => access.set({ breakMinutes: n }));
  return anchor("notch.focus", h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Focus timer") })),
    h("div", { class: "hint", text: t("How long a focus session and its break last.") }),
    h("div", { class: "row" }, h("label", { text: t("Focus") }), focus, h("span", { class: "hint", text: t("minutes") })),
    h("div", { class: "row" }, h("label", { text: t("Break") }), rest, h("span", { class: "hint", text: t("minutes") })),
  ));
}

export function notchSections(access: SettingsAccess): HTMLElement[] {
  return [...sidesSections(access), calendarSection(access), focusSection(access)];
}
