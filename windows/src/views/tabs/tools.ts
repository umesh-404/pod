// The Tools tab: four small cards, each one hidden when its feature is
// switched off in Settings (State.settings.disabledFeatures).
// - Screenshot to shelf: folds the island, lets the user pick an area, and the
//   PNG lands on the shelf.
// - Focus timer: a focus block then a break (core/focus.ts), with a ring that
//   runs on its own CSS transition: nothing ticks.
// - Smart clipboard: reads the clipboard when the tab shows and offers its
//   decoded forms (core/smart-clip.ts).
// - Dev servers: the local servers listening right now, while the tab shows.

import { Bridge, type DevServer } from "../../core/bridge";
import { Focus, type FocusState } from "../../core/focus";
import { analyze, type ClipResult } from "../../core/smart-clip";
import { State } from "../../core/state";
import { h, svg } from "../dom";
import { ICONS } from "../icons";
import { N_, t, tl } from "../../i18n/i18n";
import { GLYPHS } from "./glyphs";
import { clampHeight, errorMessage, formatTime, listenWhile, reducedMotion } from "./common";
import type { Tab, TabHost } from "./tab";

export const TOOL_IDS = ["capture", "focus", "clipboard", "devservers"] as const;
export type ToolId = (typeof TOOL_IDS)[number];

const PAD = 12;
const GAP = 8;
const SMALL_ROW = 120;
const TALL_ROW = 184;
const RING_R = 17;
const RING_C = 2 * Math.PI * RING_R;
const TOAST_MS = 8000;

/** smart-clip's labels that have a translation ("JWT", "JSON"… read the same everywhere). */
export const CLIP_LABELS = [N_("Unix time"), N_("URL-encoded"), N_("Color")];

export function visibleTools(disabled: readonly string[] = State.settings.disabledFeatures ?? []): ToolId[] {
  return TOOL_IDS.filter((id) => !disabled.includes(id));
}

/** Cards flow two per row; a row holding the clipboard or the servers is taller. */
export function toolsHeight(visible: readonly ToolId[]): number {
  if (visible.length === 0) return clampHeight(0);
  let total = PAD * 2;
  for (let i = 0; i < visible.length; i += 2) {
    const row = visible.slice(i, i + 2);
    const tall = row.some((id) => id === "clipboard" || id === "devservers");
    total += (tall ? TALL_ROW : SMALL_ROW) + (i > 0 ? GAP : 0);
  }
  return clampHeight(total);
}

function card(
  id: ToolId,
  icon: SVGSVGElement,
  title: ReturnType<typeof tl>,
  extra: Node | null,
  ...body: (Node | null)[]
): HTMLElement {
  return h(
    "section",
    { class: `tool-card tool-${id}`, "data-tool": id },
    h("div", { class: "tool-head" }, h("span", { class: "tool-icon" }, icon), h("span", { class: "tool-title", text: title }), extra),
    ...body,
  );
}

function miniBtn(label: ReturnType<typeof tl> | string, onClick: () => void, kind = ""): HTMLButtonElement {
  return h("button", { class: `mini-btn ${kind}`.trim(), text: label, onclick: onClick });
}

export function toolsTab(host: TabHost): Tab {
  let shown = false;
  let visible = visibleTools();
  let lastHeight = toolsHeight(visible);

  // ── Screenshot ─────────────────────────────────────────────────────────────

  const toast = h("div", { class: "tool-toast", "aria-live": "polite" });
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let capturing = false;

  /** The result waits for the island to open again (capture folded it), then stays a few seconds. */
  function showToast(text: string, tone: "ok" | "error") {
    toast.textContent = text;
    toast.title = text;
    toast.className = `tool-toast on ${tone}`;
    if (shown) startToastTimer();
  }

  function startToastTimer() {
    if (toastTimer != null) clearTimeout(toastTimer);
    toastTimer = null;
    if (!toast.classList.contains("on")) return;
    toastTimer = setTimeout(() => {
      toastTimer = null;
      toast.classList.remove("on");
    }, TOAST_MS);
  }

  function stopToastTimer() {
    if (toastTimer == null) return;
    // It was already seen: it goes with the island.
    clearTimeout(toastTimer);
    toastTimer = null;
    toast.classList.remove("on");
  }

  const captureBtn = miniBtn(tl("Capture"), () => void capture(), "primary");
  const captureCard = card(
    "capture",
    svg(GLYPHS.viewfinder, 14, { stroke: 1.8 }),
    tl("Screenshot to shelf"),
    null,
    h("div", { class: "tool-sub", text: tl("Pick an area of the screen") }),
    h("div", { class: "tool-actions" }, captureBtn),
    toast,
  );

  async function capture() {
    if (capturing) return;
    capturing = true;
    captureBtn.classList.add("busy");
    // The island folds first, so it is not in the picture.
    host.close();
    try {
      const saved = await Bridge.captureToShelf();
      const name = String(saved ?? "").split(/[\\/]/).pop() || "";
      showToast(name ? t("Saved {name} to the shelf", { name }) : t("Saved to shelf"), "ok");
      host.sound("pop");
    } catch (err) {
      const msg = errorMessage(err);
      if (!/cancel/i.test(msg)) {
        showToast(`${t("Couldn't capture")}: ${msg}`, "error");
        host.sound("error");
      }
    } finally {
      capturing = false;
      captureBtn.classList.remove("busy");
    }
  }

  // ── Focus timer ────────────────────────────────────────────────────────────

  const ns = "http://www.w3.org/2000/svg";
  const ringSvg = document.createElementNS(ns, "svg");
  ringSvg.setAttribute("class", "focus-ring");
  ringSvg.setAttribute("viewBox", "0 0 44 44");
  ringSvg.setAttribute("width", "44");
  ringSvg.setAttribute("height", "44");
  ringSvg.setAttribute("aria-hidden", "true");
  const track = document.createElementNS(ns, "circle");
  const arc = document.createElementNS(ns, "circle");
  for (const c of [track, arc]) {
    c.setAttribute("cx", "22");
    c.setAttribute("cy", "22");
    c.setAttribute("r", String(RING_R));
    c.setAttribute("fill", "none");
    c.setAttribute("stroke-width", "3.5");
  }
  track.setAttribute("class", "focus-track");
  arc.setAttribute("class", "focus-arc");
  arc.setAttribute("stroke-linecap", "round");
  arc.setAttribute("stroke-dasharray", RING_C.toFixed(2));
  ringSvg.append(track, arc);

  const focusPhase = h("div", { class: "focus-phase" });
  const focusSub = h("div", { class: "tool-sub focus-sub" });
  const focusActions = h("div", { class: "tool-actions" });
  const focusCard = card(
    "focus",
    svg(ICONS.timer, 14),
    tl("Focus timer"),
    null,
    h("div", { class: "focus-body" }, ringSvg, h("div", { class: "focus-text" }, focusPhase, focusSub)),
    focusActions,
  );
  let focusOff: (() => void) | null = null;
  let focusKey = "";

  function paintRing(s: FocusState) {
    const style = (arc as unknown as HTMLElement).style;
    if (s.phase === "off" || s.length <= 0) {
      style.transition = "none";
      style.strokeDashoffset = "0";
      return;
    }
    const left = Math.max(0, s.endsAt - Date.now());
    const done = Math.min(1, 1 - left / s.length);
    // Jump to where the phase is, then let one linear transition run it out.
    style.transition = "none";
    style.strokeDashoffset = (RING_C * done).toFixed(2);
    if (!shown || left <= 0) return;
    void ringSvg.getBoundingClientRect();
    requestAnimationFrame(() => {
      style.transition = `stroke-dashoffset ${left}ms linear`;
      style.strokeDashoffset = RING_C.toFixed(2);
    });
  }

  function paintFocus(s: FocusState = Focus.state()) {
    for (const p of ["off", "focus", "break"]) focusCard.classList.toggle(`phase-${p}`, p === s.phase);
    if (s.phase === "off") {
      focusPhase.textContent = t("Ready");
      focusSub.textContent = t("{focus} min focus · {break} min break", {
        focus: State.settings.focusMinutes,
        break: State.settings.breakMinutes,
      });
    } else {
      focusPhase.textContent = s.phase === "focus" ? t("Focus") : t("Break");
      focusSub.textContent = t("Until {time}", { time: formatTime(s.endsAt) });
    }
    const key = s.phase;
    if (key !== focusKey) {
      focusKey = key;
      focusActions.replaceChildren(
        ...(s.phase === "off"
          ? [miniBtn(tl("Start"), () => Focus.start(), "primary")]
          : [
              miniBtn(tl("Stop"), () => Focus.stop()),
              h("button", { class: "mini-btn icon", title: tl("Skip"), "aria-label": tl("Skip"), onclick: () => Focus.skip() }, svg(GLYPHS.skip, 11, { stroke: 1.8 })),
            ]),
      );
    }
    paintRing(s);
  }

  // ── Smart clipboard ────────────────────────────────────────────────────────

  const clipList = h("div", { class: "clip-list" });
  const clipRefresh = h(
    "button",
    { class: "tool-refresh", title: tl("Read the clipboard again"), "aria-label": tl("Read the clipboard again"), onclick: () => void readClipboard() },
    svg(GLYPHS.refresh, 12, { stroke: 1.8 }),
  );
  const clipCard = card("clipboard", svg(GLYPHS.clipboard, 14, { stroke: 1.8 }), tl("Smart clipboard"), clipRefresh, clipList);
  let clipSeq = 0;

  function clipRow(r: ClipResult): HTMLElement {
    const copy = h("button", { class: "mini-btn", text: tl("Copy") });
    let reset: ReturnType<typeof setTimeout> | null = null;
    copy.addEventListener("click", () => {
      Bridge.clipboardSetText(r.output)
        .then(() => {
          copy.textContent = t("Copied");
          copy.classList.add("done");
          if (reset != null) clearTimeout(reset);
          reset = setTimeout(() => {
            copy.textContent = t("Copy");
            copy.classList.remove("done");
          }, 1400);
        })
        .catch(() => host.sound("error"));
    });
    return h(
      "div",
      { class: `clip-row clip-${r.kind}` },
      h("div", { class: "clip-row-head" }, h("span", { class: "clip-label", text: t(r.label) }), copy),
      h("pre", { class: "clip-out", text: r.output }),
    );
  }

  async function readClipboard() {
    const seq = ++clipSeq;
    const text = await Bridge.clipboardText();
    if (seq !== clipSeq) return;
    const results = analyze(text ?? "");
    if (results.length === 0) {
      clipList.replaceChildren(h("div", { class: "tool-empty", text: tl("Nothing special on the clipboard") }));
    } else {
      clipList.replaceChildren(...results.map(clipRow));
    }
  }

  // ── Dev servers ────────────────────────────────────────────────────────────

  const serverList = h("div", { class: "server-list" });
  const serversCard = card("devservers", svg(GLYPHS.server, 14, { stroke: 1.8 }), tl("Dev servers"), null, serverList);
  let serversOff: (() => void) | null = null;

  function paintServers(list: DevServer[] | null) {
    const servers = [...(list ?? [])].sort((a, b) => a.port - b.port);
    if (servers.length === 0) {
      serverList.replaceChildren(h("div", { class: "tool-empty", text: tl("No dev servers running") }));
      return;
    }
    serverList.replaceChildren(
      ...servers.map((s) =>
        h(
          "div",
          { class: "server-row", title: s.url },
          h("span", { class: "server-port", text: `:${s.port}` }),
          h("span", { class: "server-proc", text: s.process || String(s.pid) }),
          h(
            "button",
            {
              class: "mini-btn icon",
              title: tl("Open"),
              "aria-label": tl("Open"),
              onclick: () => {
                Bridge.devserverOpen(s.port).catch(() => host.sound("error"));
              },
            },
            svg(ICONS.arrowUpRight, 11),
          ),
        ),
      ),
    );
  }

  // ── Tab ────────────────────────────────────────────────────────────────────

  const cards: Record<ToolId, HTMLElement> = {
    capture: captureCard,
    focus: focusCard,
    clipboard: clipCard,
    devservers: serversCard,
  };
  const grid = h("div", { class: "tools-grid" });
  const empty = h("div", { class: "tab-empty" }, h("div", { class: "tab-empty-text", text: tl("All tools are off in Settings") }));
  const el = h("div", { class: "tab-view tab-tools" }, grid, empty);

  let layoutKey = "";
  for (const c of Object.values(cards)) c.addEventListener("animationend", () => c.classList.add("settled"));

  function layout() {
    visible = visibleTools();
    const key = visible.join(",");
    if (key === layoutKey) return;
    layoutKey = key;
    const nodes: HTMLElement[] = [];
    for (let i = 0; i < visible.length; i++) {
      const c = cards[visible[i]];
      // A card alone on its row takes the whole row.
      const alone = i === visible.length - 1 && visible.length % 2 === 1;
      c.classList.toggle("wide", alone);
      const row = Math.floor(i / 2);
      const tall = visible.slice(row * 2, row * 2 + 2).some((id) => id === "clipboard" || id === "devservers");
      c.classList.toggle("tall", tall);
      nodes.push(c);
    }
    grid.replaceChildren(...nodes);
    el.classList.toggle("is-empty", visible.length === 0);
    const next = toolsHeight(visible);
    if (next !== lastHeight) {
      lastHeight = next;
      host.resize();
    }
  }

  layout();
  paintFocus();
  el.classList.toggle("reduced", reducedMotion());

  // A shortcut opened this tab for something in particular (island/tabs.ts, TAB_INTENT_EVENT).
  window.addEventListener?.("pod-tab-intent", ((e: CustomEvent<{ tab: string; intent: string }>) => {
    if (e.detail?.tab === "tools" && e.detail.intent === "clipboard") { void readClipboard(); clipCard.scrollIntoView({ block: "nearest" }); }
  }) as EventListener);

  return {
    id: "tools",
    el,
    show() {
      if (shown) return;
      shown = true;
      layout();
      startToastTimer();
      if (visible.includes("focus")) {
        focusOff = Focus.on((s) => paintFocus(s));
        paintFocus();
      }
      if (visible.includes("clipboard")) void readClipboard();
      if (visible.includes("devservers")) {
        serversOff = listenWhile<DevServer[]>("dev-servers", (list) => paintServers(list));
        void Bridge.devserversWatch(true);
        void Bridge.devserversNow().then((list) => {
          if (shown) paintServers(list);
        });
      }
    },
    hide() {
      if (!shown) return;
      shown = false;
      focusOff?.();
      focusOff = null;
      // Freeze the ring where it is: no transition runs while hidden.
      paintRing({ phase: "off", endsAt: 0, length: 0 });
      clipSeq++;
      stopToastTimer();
      if (serversOff) {
        serversOff();
        serversOff = null;
        void Bridge.devserversWatch(false);
      }
    },
    height: () => toolsHeight(visibleTools()),
  };
}
