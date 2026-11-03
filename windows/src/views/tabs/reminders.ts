// The Reminders tab: type "Call Sam at 4pm", see what Pod understood, press
// Enter. Deadlines ("submit the report by Friday") count down on the left of
// the compact notch; reminders that fired wait here with Done and Snooze.
// One minute timer redraws the countdowns, and only while the tab is shown.

import { Bridge, type ParsedReminder, type Reminder } from "../../core/bridge";
import { h, svg } from "../dom";
import { ICONS } from "../icons";
import { t, tl } from "../../i18n/i18n";
import { GLYPHS } from "./glyphs";
import { clampHeight, formatCountdown, formatDue, holder, listenWhile } from "./common";
import type { Tab, TabHost } from "./tab";

const PARSE_DEBOUNCE = 150;
const INPUT_H = 92;
const ROW_H = 40;
const PAD = 12;

/** Words that make a new entry a deadline by default. */
const DEADLINE_WORDS = /\b(by|due|deadline|exam|submit|submission)\b/i;

export function looksLikeDeadline(text: string): boolean {
  return DEADLINE_WORDS.test(text);
}

/** Fired first (oldest first), then by time. */
export function sortReminders(list: Reminder[]): Reminder[] {
  return [...list].sort((a, b) => (a.fired === b.fired ? a.due - b.due : a.fired ? -1 : 1));
}

export function remindersHeight(count: number): number {
  const list = count === 0 ? 40 : count * ROW_H + (count - 1) * 4;
  return clampHeight(PAD + INPUT_H + list + PAD);
}

export function remindersTab(host: TabHost): Tab {
  const hold = holder(host);
  let list: Reminder[] = [];
  let shown = false;
  let lastHeight = remindersHeight(0);
  let unlisten: (() => void) | null = null;
  let minuteTimer: ReturnType<typeof setTimeout> | null = null;
  let parseTimer: ReturnType<typeof setTimeout> | null = null;
  let parsed: ParsedReminder | null = null;
  let parseSeq = 0;
  /** The user picked Reminder or Deadline by hand: the text no longer decides. */
  let kindPicked = false;
  let deadline = false;
  let adding = false;

  // ── Input ──────────────────────────────────────────────────────────────────

  const input = h("input", {
    class: "rem-input",
    type: "text",
    placeholder: tl("Remind me…"),
    "aria-label": tl("Remind me…"),
    spellcheck: "false",
    autocomplete: "off",
    maxlength: "200",
  });
  input.value = "";
  const segReminder = h("button", { class: "rem-seg-btn", "aria-pressed": "true", text: tl("Reminder") });
  const segDeadline = h("button", { class: "rem-seg-btn", "aria-pressed": "false", text: tl("Deadline") });
  const segThumb = h("i", { class: "rem-seg-thumb" });
  const seg = h("div", { class: "rem-seg", role: "group" }, segThumb, segReminder, segDeadline);
  const previewIcon = h("span", { class: "rem-preview-icon" });
  const previewText = h("span", { class: "rem-preview-text" });
  const preview = h("div", { class: "rem-preview hint" }, previewIcon, previewText);
  const form = h("div", { class: "rem-form" }, h("div", { class: "rem-input-row" }, input, seg), preview);

  const rows = h("div", { class: "rem-list", role: "list" });
  const empty = h("div", { class: "tab-empty small" }, h("div", { class: "tab-empty-text", text: tl("No reminders yet") }));
  const el = h("div", { class: "tab-view tab-reminders" }, form, rows, empty);

  function setKind(isDeadline: boolean) {
    deadline = isDeadline;
    seg.classList.toggle("right", isDeadline);
    segReminder.setAttribute("aria-pressed", String(!isDeadline));
    segDeadline.setAttribute("aria-pressed", String(isDeadline));
  }
  segReminder.addEventListener("click", () => {
    kindPicked = true;
    setKind(false);
    input.focus();
  });
  segDeadline.addEventListener("click", () => {
    kindPicked = true;
    setKind(true);
    input.focus();
  });
  setKind(false);

  function showPreview() {
    const text = input.value.trim();
    previewIcon.replaceChildren();
    if (!text) {
      preview.className = "rem-preview hint";
      previewText.textContent = t("Add a time, like 'at 4pm' or 'in 20 min'");
      return;
    }
    if (parsed && parsed.due != null) {
      preview.className = "rem-preview ok";
      previewIcon.append(svg(deadline ? GLYPHS.flag : GLYPHS.bell, 12, { stroke: 1.8 }));
      const what = parsed.text.trim() || text;
      previewText.textContent = `${what} · ${formatDue(parsed.due)}`;
    } else {
      preview.className = "rem-preview hint";
      previewText.textContent = t("Add a time, like 'at 4pm' or 'in 20 min'");
    }
  }

  async function parseNow(): Promise<ParsedReminder | null> {
    const seq = ++parseSeq;
    const text = input.value.trim();
    if (!text) {
      parsed = null;
      showPreview();
      return null;
    }
    const result = await Bridge.reminderParse(text);
    if (seq !== parseSeq) return parsed; // a newer keystroke owns the preview
    parsed = result;
    showPreview();
    return result;
  }

  input.addEventListener("input", () => {
    const text = input.value;
    if (!text.trim()) kindPicked = false;
    if (!kindPicked) setKind(looksLikeDeadline(text));
    if (parseTimer != null) clearTimeout(parseTimer);
    parseTimer = setTimeout(() => {
      parseTimer = null;
      void parseNow();
    }, PARSE_DEBOUNCE);
    // The preview keeps its last answer until the new one lands: no flicker.
    if (!text.trim()) {
      parsed = null;
      showPreview();
    }
  });

  input.addEventListener("keydown", ((e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      void add();
    } else if (e.key === "Escape" && input.value) {
      e.preventDefault();
      e.stopPropagation();
      input.value = "";
      parsed = null;
      kindPicked = false;
      setKind(false);
      showPreview();
    }
  }) as EventListener);

  async function add() {
    if (adding) return;
    if (parseTimer != null) {
      clearTimeout(parseTimer);
      parseTimer = null;
    }
    // Always parse what is in the field now, not what the debounce last saw.
    const result = await parseNow();
    if (!result || result.due == null) {
      nudge();
      return;
    }
    adding = true;
    try {
      const made = await Bridge.reminderAdd(result.text.trim() || input.value.trim(), result.due, deadline);
      input.value = "";
      parsed = null;
      kindPicked = false;
      setKind(false);
      showPreview();
      host.sound("pop");
      if (made && !list.some((r) => r.id === made.id)) setList([...list, made]);
    } catch {
      nudge();
    } finally {
      adding = false;
    }
  }

  function nudge() {
    host.sound("error");
    form.classList.remove("nudge");
    // Restart the shake: reading layout commits the removal first.
    void form.offsetWidth;
    form.classList.add("nudge");
  }
  form.addEventListener("animationend", () => form.classList.remove("nudge"));

  // ── List ───────────────────────────────────────────────────────────────────

  const countdowns: { el: HTMLElement; due: number }[] = [];
  /** Rows already on screen once: only new ones play the entrance. */
  const seen = new Set<number>();

  function act(id: number, run: () => Promise<void>) {
    const row = rows.querySelector(`.rem-${id}`);
    row?.classList.add("leaving");
    run()
      .then(() => {
        setList(list.filter((r) => r.id !== id));
        void refresh();
      })
      .catch(() => {
        row?.classList.remove("leaving");
        host.sound("error");
      });
  }

  function rowFor(r: Reminder): HTMLElement {
    const icon = h("span", { class: "rem-icon" }, svg(r.deadline ? GLYPHS.flag : GLYPHS.bell, 13, { stroke: 1.8 }));
    const text = h("div", { class: "rem-text", text: r.text, title: r.text });
    const side = h("div", { class: "rem-side" });
    if (r.fired) {
      side.append(
        h("button", { class: "mini-btn primary", text: tl("Done"), onclick: () => act(r.id, () => Bridge.reminderDone(r.id)) }),
        h("button", {
          class: "mini-btn",
          text: t("{0} min", { 0: 10 }),
          title: tl("Snooze 10 minutes"),
          onclick: () => act(r.id, () => Bridge.reminderSnooze(r.id, 10)),
        }),
        h("button", {
          class: "mini-btn",
          text: t("{n}h", { n: 1 }),
          title: tl("Snooze 1 hour"),
          onclick: () => act(r.id, () => Bridge.reminderSnooze(r.id, 60)),
        }),
      );
    } else {
      const when = h("span", { class: r.deadline ? "rem-when countdown" : "rem-when" });
      if (r.deadline) {
        when.textContent = formatCountdown(r.due);
        when.title = formatDue(r.due);
        countdowns.push({ el: when, due: r.due });
      } else {
        when.textContent = formatDue(r.due);
      }
      side.append(
        when,
        h(
          "button",
          {
            class: "rem-x",
            title: tl("Remove"),
            "aria-label": tl("Remove"),
            onclick: () => act(r.id, () => Bridge.reminderDone(r.id)),
          },
          svg(ICONS.xmark, 10),
        ),
      );
    }
    return h(
      "div",
      {
        class: `rem-row rem-${r.id}${r.fired ? " fired" : ""}${r.deadline ? " deadline" : ""}${seen.has(r.id) ? " settled" : ""}`,
        role: "listitem",
      },
      icon,
      text,
      side,
    );
  }

  function render() {
    countdowns.length = 0;
    const sorted = sortReminders(list);
    rows.replaceChildren(...sorted.map(rowFor));
    for (const r of sorted) seen.add(r.id);
    el.classList.toggle("is-empty", sorted.length === 0);
    const next = remindersHeight(sorted.length);
    if (next !== lastHeight) {
      lastHeight = next;
      host.resize();
    }
    scheduleMinute();
  }

  function tickCountdowns() {
    const now = Date.now();
    for (const c of countdowns) {
      const text = formatCountdown(c.due, now);
      if (c.el.textContent !== text) c.el.textContent = text;
    }
  }

  /** One timer for every countdown, on the minute boundary, while shown. */
  function scheduleMinute() {
    if (minuteTimer != null) clearTimeout(minuteTimer);
    minuteTimer = null;
    if (!shown || countdowns.length === 0) return;
    const now = Date.now();
    minuteTimer = setTimeout(() => {
      minuteTimer = null;
      tickCountdowns();
      scheduleMinute();
    }, 60_000 - (now % 60_000) + 50);
  }

  function setList(next: Reminder[]) {
    list = next.filter((r) => r && typeof r.id === "number");
    if (shown) render();
  }

  async function refresh() {
    const got = await Bridge.remindersList();
    if (got) setList(got);
  }

  showPreview();
  render();

  // A shortcut opened this tab for something in particular (island/tabs.ts, TAB_INTENT_EVENT).
  window.addEventListener?.("pod-tab-intent", ((e: CustomEvent<{ tab: string; intent: string }>) => {
    if (e.detail?.tab === "reminders" && e.detail.intent === "new") setTimeout(() => input.focus(), 60);
  }) as EventListener);

  return {
    id: "reminders",
    el,
    show() {
      if (shown) return;
      shown = true;
      render();
      unlisten = listenWhile<Reminder[]>("reminders-changed", (l) => setList(l));
      void refresh();
    },
    hide() {
      if (!shown) return;
      shown = false;
      unlisten?.();
      unlisten = null;
      if (minuteTimer != null) clearTimeout(minuteTimer);
      minuteTimer = null;
      if (parseTimer != null) clearTimeout(parseTimer);
      parseTimer = null;
      hold.set(false);
    },
    height: () => remindersHeight(list.length),
  };
}
