// Settings → Notch: what the right of the notch shows and in which order
// (`rightWidgets`, `rotateSeconds`), the calendar links behind "Next meeting"
// (`calendarUrls`), and the focus timer's lengths (`focusMinutes`, `breakMinutes`).

import { Bridge } from "../core/bridge";
import { h, clear } from "../views/dom";
import { t, tn } from "../i18n/i18n";
import { anchor, iconButton, toggle } from "../hub/ui";
import {
  BREAK_RANGE, FOCUS_RANGE, RIGHT_ITEMS, ROTATE_RANGE, calendarLink, clampNumber, moveRow,
  rightRows, rightWidgetsOf, type RightRow,
} from "./catalog";
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

/**
 * Runs `mutate` (which reorders the children of `list`) and slides every row
 * from where it was to where it is now, with transforms only (FLIP).
 */
function animateReorder(list: HTMLElement, mutate: () => void) {
  const rows = [...list.children] as HTMLElement[];
  const before = new Map(rows.map((r) => [r, r.getBoundingClientRect?.().top ?? 0]));
  mutate();
  if (reducedMotion()) return;
  for (const r of rows) {
    const from = before.get(r);
    const to = r.getBoundingClientRect?.().top ?? 0;
    if (from === undefined || from === to || typeof r.animate !== "function") continue;
    // A row still sliding from an earlier move starts from where it is seen.
    for (const a of r.getAnimations?.() ?? []) a.cancel();
    r.animate(
      [{ transform: `translateY(${from - to}px)` }, { transform: "translateY(0)" }],
      { duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
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

// ── Right side ────────────────────────────────────────────────────────────────

function rightSection(access: SettingsAccess): HTMLElement {
  let rows: RightRow[] = rightRows(access.get().rightWidgets);
  const list = h("div", { class: "notch-list" });
  const els = new Map<string, { row: HTMLElement; up: HTMLButtonElement; down: HTMLButtonElement }>();

  const persist = () => access.set({ rightWidgets: rightWidgetsOf(rows) });

  function refreshEnds() {
    rows.forEach((r, i) => {
      const el = els.get(r.id)!;
      el.up.disabled = i === 0;
      el.down.disabled = i === rows.length - 1;
    });
  }

  function move(id: string, by: -1 | 1) {
    const index = rows.findIndex((r) => r.id === id);
    const next = moveRow(rows, index, by);
    if (next[index] === rows[index]) return;
    rows = next;
    animateReorder(list, () => list.replaceChildren(...rows.map((r) => els.get(r.id)!.row)));
    refreshEnds();
    // Keeps the focus on the moved row, on the button that still works.
    const el = els.get(id)!;
    (by < 0 ? (el.up.disabled ? el.down : el.up) : (el.down.disabled ? el.up : el.down)).focus?.();
    persist();
  }

  for (const r of rows) {
    const item = RIGHT_ITEMS.find((i) => i.id === r.id)!;
    const up = iconButton("chevronUp", t("Move up"), () => move(r.id, -1)) as HTMLButtonElement;
    const down = iconButton("chevronDown", t("Move down"), () => move(r.id, 1)) as HTMLButtonElement;
    const row = h("div", { class: r.on ? "notch-row" : "notch-row off" },
      h("div", { class: "text" },
        h("span", { class: "name", text: t(item.title) }),
        h("span", { class: "detail", text: t(item.detail) }),
      ),
      up,
      down,
    );
    const sw = toggle(r.on, (on) => {
      rows = rows.map((x) => (x.id === r.id ? { ...x, on } : x));
      row.classList.toggle("off", !on);
      persist();
    });
    sw.setAttribute("aria-label", t(item.title));
    row.append(sw);
    els.set(r.id, { row, up, down });
    list.append(row);
  }
  refreshEnds();

  const seconds = numberField(
    clampNumber(access.get().rotateSeconds, ROTATE_RANGE, 6), ROTATE_RANGE,
    (n) => access.set({ rotateSeconds: n }),
  );

  return anchor("notch.right", h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Right side of the notch") })),
    h("div", { class: "hint", text: t("The items switched on take turns on the right of the notch, in this order. One with nothing to show is skipped.") }),
    list,
    h("div", { class: "row" },
      h("label", { text: t("Seconds per item") }),
      seconds,
      h("span", { class: "hint", text: t("seconds") }),
    ),
  ));
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
  return [rightSection(access), calendarSection(access), focusSection(access)];
}
