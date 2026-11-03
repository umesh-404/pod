// The drag-and-drop file views: the drop tiles shown while files are dragged
// over the island (dropTargets), and the card of what came of the drop
// (fileAction) — moved into the workspace, converted with ffmpeg, zipped,
// resized, PDF tools, and the file tools: the text read from a picture, a
// SHA-256, a clean copy, a batch rename with its pattern field and preview.
// The flow lives in island/file-actions.ts; these only draw State.

import "./file-tools.css";
import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import { State, type FileAction } from "../core/state";
import { DROP_GEOMETRY, dropTargetsGeometry, washRGBA, type DropActionId, type Wash } from "../core/layout";
import {
  DROP_ACTIONS, FileActions, RESIZE_PRESETS, fileActionProgress, fileActionText, hashVerdict, type ResizePreset,
} from "../island/file-actions";
import type { FormatOption } from "../core/bridge";
import type { ViewHost } from "./views";
import { language, t, tl } from "../i18n/i18n";

/** What the file action card's buttons do (island/file-actions.ts). */
export interface FileCardActions {
  pick(format: FormatOption): void;
  /** A size on the resize card. */
  resize(preset: ResizePreset): void;
  downloadFfmpeg(): void;
  cancel(): void;
  close(): void;
  openWorkspace(): void;
  revealOutput(): void;
}

/** The drop card's marching dashed outline, sized to its tile. */
function dashedFrame(radius: number): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(ns, "svg");
  el.setAttribute("class", "drop-frame");
  el.setAttribute("preserveAspectRatio", "none");
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", "0.75");
  rect.setAttribute("y", "0.75");
  rect.setAttribute("width", "calc(100% - 1.5px)");
  rect.setAttribute("height", "calc(100% - 1.5px)");
  rect.setAttribute("rx", String(radius));
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke-width", "1.5");
  rect.setAttribute("stroke-dasharray", "6 5");
  el.append(rect);
  return el;
}

function lit(frame: SVGSVGElement): SVGSVGElement {
  frame.classList.add("lit");
  return frame;
}

// ── Drop targets ──────────────────────────────────────────────────────────────

export function buildDropTargets(): ViewHost {
  const subs = new Map<DropActionId, HTMLElement>();
  // One tile per action, built once; a drag shows 1 to MAX_DROP_TILES of them (State.dropTiles).
  const tiles = DROP_ACTIONS.map((action) => {
    const sub = h("div", { class: "tile-sub", text: action.id === "workspace" ? "" : tl(action.sub) });
    subs.set(action.id, sub);
    const tile = h(
      "div",
      { class: `card drop-card drop-tile ${action.id}`, "data-action": action.id },
      dashedFrame(16),
      // The lit outline and glow sit on top and cross-fade in (opacity only).
      h("div", { class: "tile-glow" }),
      lit(dashedFrame(16)),
      h(
        "div",
        { class: "tile-body" },
        h("div", { class: "tile-icon" }, svg(ICONS[action.icon], 17, { stroke: action.stroke, evenOdd: action.evenOdd })),
        h("div", { class: "tile-title", text: tl(action.title) }),
        sub,
      ),
    );
    return { id: action.id, tile };
  });
  const el = h("div", { class: "view drop-targets" });
  let laidOut = "";

  /** Puts the tiles this drag shows in their places; the others leave the view. */
  function layout() {
    const shown = State.dropTiles;
    const key = shown.join(",");
    if (key === laidOut) return;
    laidOut = key;
    const geometry = shown.length === DROP_GEOMETRY.tiles.length ? DROP_GEOMETRY : dropTargetsGeometry(shown.length);
    clear(el);
    shown.forEach((id, i) => {
      const entry = tiles.find((x) => x.id === id);
      const r = geometry.tiles[i];
      if (!entry || !r) return;
      const { tile } = entry;
      // Placed in the view, which covers the island's body from its 8 px top inset
      // (the header row is there but faded out) and 10 px side insets.
      tile.style.left = `${r.x - 10}px`;
      tile.style.top = `${r.y - 8}px`;
      tile.style.setProperty("--i", String(i));
      tile.style.width = `${r.w}px`;
      tile.style.height = `${r.h}px`;
      // The grid puts every icon beside its text, the row above it: one look per
      // layout, even where a column's tiles stretch taller.
      tile.classList.toggle("flat", geometry.flat);
      el.append(tile);
    });
  }
  layout();

  return {
    el,
    sync() {
      layout();
      for (const { id, tile } of tiles) tile.classList.toggle("hot", State.dropZone === id);
      const ws = subs.get("workspace");
      if (ws) {
        const name = State.workspaceName || t("Workspace");
        if (ws.textContent !== name) {
          ws.textContent = name;
          ws.title = name;
        }
      }
    },
  };
}

// ── File action card ──────────────────────────────────────────────────────────

function button(label: string, kind: "primary" | "secondary", onClick: () => void): HTMLElement {
  return h("button", { class: `btn ${kind}`, onclick: onClick }, h("span", { text: label }));
}

function washFor(s: FileAction | null): Wash {
  switch (s?.kind) {
    case "done":
    case "text":
      return "green";
    case "written":
      return s.outputs.length > 0 ? "green" : "red";
    case "moved":
      return s.moved.length > 0 ? "green" : "red";
    case "hashed": {
      const verdict = hashVerdict(s.hashes, s.expected);
      return verdict === "match" ? "green" : verdict === "mismatch" ? "red" : null;
    }
    case "renamed":
      return s.report.renamed.length > 0 ? "green" : s.report.failed.length > 0 ? "red" : null;
    case "error":
      return "red";
    default:
      return null;
  }
}

/** The file tools' own controls, straight to the controller the island made. */
const tools = () => FileActions.current;

export function buildFileAction(actions: FileCardActions): ViewHost {
  const check = h("span", { class: "fa-check" }, svg(ICONS.check, 13, { stroke: 2.6 }));
  const titleText = h("span", { class: "fa-title-text" });
  const title = h("div", { class: "title fa-title" }, check, titleText);
  const sub = h("div", { class: "sub fa-sub" });
  const fill = h("div", { class: "up-fill" });
  const glow = h("div", { class: "up-glow" });
  // The glow rides a full-width rail moved by transform, so nothing animates `left`.
  const rail = h("div", { class: "fa-rail" }, glow);
  const bar = h("div", { class: "up-track fa-track" }, fill, rail);
  const row = h("div", { class: "actions options fa-actions" });

  // Text from image: what was read, selectable, scrolled when long.
  const textBox = h("div", { class: "fa-textbox", tabindex: "0" });
  // SHA-256: the hash (or one line per file), selectable.
  const hashBox = h("div", { class: "fa-hash", tabindex: "0" });
  // Batch rename: the pattern field, Rename and Cancel, then the preview.
  const input = h("input", {
    class: "rem-input fa-rename-input",
    type: "text",
    placeholder: tl("Trip {n}"),
    "aria-label": tl("New name"),
    spellcheck: "false",
    autocomplete: "off",
    maxlength: "200",
  });
  input.value = "";
  const renameBtn = h(
    "button",
    { class: "btn primary fa-rename-go", onclick: () => void tools()?.renameApply() },
    h("span", { text: tl("Rename") }),
  );
  const renameCancel = h("button", { class: "link-btn fa-link", text: tl("Cancel"), onclick: () => actions.close() });
  const renameRow = h("div", { class: "rem-input-row fa-rename-row" }, input, renameBtn, renameCancel);
  const preview = h("div", { class: "fa-preview", "aria-live": "polite" });

  const stack = h("div", { class: "stack fa-stack" }, title, sub, renameRow, preview, textBox, hashBox, bar, row);
  const card = h("div", { class: "card file-action" }, stack);
  const el = h("div", { class: "view" }, card);

  input.addEventListener("input", () => tools()?.renamePattern(input.value));
  input.addEventListener("keydown", ((e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      void tools()?.renameApply();
    } else if (e.key === "Escape") {
      // Cancels the rename, not just the island's own Escape.
      e.preventDefault();
      e.stopPropagation();
      actions.close();
    }
  }) as EventListener);

  // Buttons are only rebuilt when what they offer changes: rebuilding them
  // between a mouse-down and a mouse-up would swallow the click.
  let rowKey = "";
  function buttons(key: string, make: () => HTMLElement[]) {
    const full = `${key}~${language()}`;
    if (full === rowKey) return;
    rowKey = full;
    clear(row);
    row.append(...make());
  }
  const cancelLink = (onClick: () => void) =>
    h("button", { class: "link-btn fa-link", text: tl("Cancel"), onclick: onClick });
  /** A line at the end of the buttons (the hash's verdict, what failed): the card has no room for another row. */
  const note = (text: string, tone: string) => h("span", { class: `fa-note ${tone}`, text, title: text });

  let renameJob: number | null = null;
  let shownText = "";
  let shownHash = "";

  return {
    el,
    sync() {
      const s = State.fileAction;
      const wash = washFor(s);
      card.classList.toggle("wash", wash != null);
      card.style.setProperty("--wash", washRGBA(wash));
      if (!s) {
        renameJob = null;
        return;
      }
      card.dataset.kind = s.kind;

      const text = fileActionText(s);
      if (titleText.textContent !== text.title) titleText.textContent = text.title;
      title.title = text.title;
      const success = s.kind === "done" || s.kind === "text"
        || (s.kind === "hashed" && hashVerdict(s.hashes, s.expected) === "match")
        || (s.kind === "renamed" && s.report.renamed.length > 0 && s.report.failed.length === 0);
      check.style.display = success ? "" : "none";
      // The text and hash cards say it at the end of their buttons instead.
      const subInRow = s.kind === "text" || s.kind === "hashed";
      sub.textContent = text.sub;
      sub.title = text.sub;
      sub.style.display = text.sub && !subInRow ? "" : "none";
      sub.classList.toggle("error", text.tone === "error");
      sub.classList.toggle("ok", text.tone === "ok");

      const p = fileActionProgress(s);
      bar.style.display = p == null ? "none" : "";
      if (p != null) {
        const pct = (p * 100).toFixed(1);
        fill.style.transform = `scaleX(${p.toFixed(4)})`;
        rail.style.transform = `translateX(${pct}%)`;
        glow.style.opacity = p > 0.01 && p < 0.999 ? "1" : "0";
      }

      // Text from image.
      textBox.style.display = s.kind === "text" ? "" : "none";
      if (s.kind === "text" && shownText !== s.text) {
        shownText = s.text;
        textBox.textContent = s.text;
        textBox.scrollTop = 0;
      }
      // SHA-256.
      hashBox.style.display = s.kind === "hashed" ? "" : "none";
      if (s.kind === "hashed") {
        const lines = s.hashes.length === 1 ? s.hashes[0].sha256 : s.hashes.map((x) => `${x.sha256}  ${x.name}`).join("\n");
        if (shownHash !== lines) {
          shownHash = lines;
          hashBox.textContent = lines;
          hashBox.classList.toggle("many", s.hashes.length > 1);
        }
      }
      // Batch rename.
      const renaming = s.kind === "rename";
      renameRow.style.display = renaming ? "" : "none";
      preview.style.display = renaming && !s.error && s.rows.length > 0 ? "" : "none";
      if (renaming) {
        if (renameJob !== s.job.id) {
          // A new rename: an empty field, with the keyboard.
          renameJob = s.job.id;
          input.value = s.pattern;
          void Bridge.focusWindow(true);
          requestAnimationFrame(() => input.focus({ preventScroll: true }));
        }
        const ready = !!s.pattern.trim() && !s.error && s.rows.length > 0;
        renameBtn.classList.toggle("off", !ready);
        renameBtn.toggleAttribute("disabled", !ready);
        renderPreview(preview, s.rows);
      } else {
        renameJob = null;
      }

      switch (s.kind) {
        case "working":
          buttons("working", () => []);
          break;
        case "moved":
          buttons(`moved~${s.moved.length > 0}`, () => [
            ...(s.moved.length > 0 ? [button(t("Open workspace"), "primary", () => actions.openWorkspace())] : []),
            button(t("Done"), "secondary", () => actions.close()),
          ]);
          break;
        case "pick":
          buttons(`pick~${s.job.id}`, () => [
            ...s.job.formats.map((f) => button(f.label, "secondary", () => actions.pick(f))),
            cancelLink(() => actions.close()),
          ]);
          break;
        case "needsFfmpeg":
          buttons(`ffmpeg~${s.canDownload}`, () =>
            s.canDownload
              ? [
                  button(t("Download ffmpeg"), "primary", () => actions.downloadFfmpeg()),
                  button(t("Cancel"), "secondary", () => actions.close()),
                ]
              : [button(t("OK"), "secondary", () => actions.close())],
          );
          break;
        case "downloading":
          buttons("downloading", () => []);
          break;
        case "converting":
        case "hashing":
          buttons(s.kind, () => [button(t("Cancel"), "secondary", () => actions.cancel())]);
          break;
        case "done":
          buttons("done", () => [
            button(t("Show in folder"), "primary", () => actions.revealOutput()),
            button(t("Done"), "secondary", () => actions.close()),
          ]);
          break;
        case "resize":
          buttons("resize", () => [
            ...RESIZE_PRESETS.map((p) =>
              button(p === "half" ? t("Half size") : `${p} px`, "secondary", () => actions.resize(p))),
            cancelLink(() => actions.close()),
          ]);
          break;
        case "written":
          buttons(`written~${s.outputs.length > 0}`, () => [
            ...(s.outputs.length > 0 ? [button(t("Show in folder"), "primary", () => actions.revealOutput())] : []),
            button(t("Done"), "secondary", () => actions.close()),
          ]);
          break;
        case "text":
          buttons(`text~${s.copied}~${s.outputs.length > 0}~${text.sub}`, () => [
            button(s.copied ? t("Copied") : t("Copy"), s.copied ? "secondary" : "primary", () => void tools()?.copyText()),
            ...(s.outputs.length > 0 ? [button(t("Show in folder"), "secondary", () => actions.revealOutput())] : []),
            button(t("Done"), "secondary", () => actions.close()),
            ...(text.sub ? [note(text.sub, text.tone)] : []),
          ]);
          break;
        case "hashed":
          buttons(`hashed~${s.copied}~${text.sub}`, () => [
            button(s.copied ? t("Copied") : t("Copy"), s.copied ? "secondary" : "primary", () => void tools()?.copyHash()),
            button(t("Done"), "secondary", () => actions.close()),
            note(text.sub, text.tone),
          ]);
          break;
        case "rename":
          // Its buttons are beside the field.
          buttons("rename", () => []);
          break;
        case "renamed":
          buttons(`renamed~${s.undone}~${s.report.renamed.length > 0}`, () => [
            ...(!s.undone && s.report.renamed.length > 0
              ? [button(t("Undo"), "secondary", () => void tools()?.renameUndo())]
              : []),
            button(t("Done"), "primary", () => actions.close()),
          ]);
          break;
        case "error":
          buttons("error", () => [button(t("Done"), "secondary", () => actions.close())]);
          break;
        case "soon":
          buttons("soon", () => [button(t("OK"), "secondary", () => actions.close())]);
          break;
      }
    },
  };
}

/** The rename preview: "old → new" per file, the unchanged ones dimmed. */
function renderPreview(el: HTMLElement, rows: readonly { from: string; to: string }[]) {
  const key = rows.map((r) => `${r.from}\u0000${r.to}`).join("\u0001");
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  clear(el);
  for (const r of rows) {
    const same = r.from === r.to;
    el.append(
      h(
        "div",
        { class: `fa-preview-row${same ? " same" : ""}`, title: `${r.from} → ${r.to}` },
        h("span", { class: "from", text: r.from }),
        h("span", { class: "arrow", text: "→" }),
        h("span", { class: "to", text: r.to }),
      ),
    );
  }
}
