// Settings → General → Workspace: the folder files dropped on "Move to
// workspace" go to (change it, open it), and the ffmpeg the "Convert" target
// uses (download it, or pick one by hand). Rust shows the folder picker and
// the "Move N items?" confirmation itself (src-tauri/src/workspace.rs).

import { Bridge, type FfmpegStatus, type WorkspaceChange, type WorkspaceInfo } from "../core/bridge";
import { h, clear } from "../views/dom";
import { t, tn } from "../i18n/i18n";
import { statusDot } from "./parts";

/** `ffmpeg-download` progress, in bytes. */
export interface FfmpegDownloadEvent {
  received: number;
  total: number | null;
  done: boolean;
  error: string | null;
}

/** The section on screen, told about events (listened to once in main.ts). */
export let workspaceListener: {
  /** Settings changed or the window came back: the folder may have changed. */
  refresh: () => void;
  download: (e: FfmpegDownloadEvent) => void;
} | null = null;

/** A long path keeps its start and its end; the full one is in the tooltip. */
function shortPath(path: string, max = 64): string {
  if (path.length <= max) return path;
  const head = Math.ceil((max - 1) * 0.35);
  const tail = max - 1 - head;
  return `${path.slice(0, head)}…${path.slice(path.length - tail)}`;
}

function itemCount(n: number): string {
  if (n === 0) return t("Empty");
  return tn("{count} item", "{count} items", n);
}

function megabytes(bytes: number): string {
  return String(Math.round(bytes / 1_000_000));
}

const errText = (err: unknown) => String(err).replace(/^Error:\s*/, "");

export function workspaceSection(): HTMLElement {
  // ── Folder ───────────────────────────────────────────────────────────────
  let info: WorkspaceInfo | null = null;
  let changing = false;
  const path = h("span", { class: "path" });
  const meta = h("span", { class: "hint" });
  const feedback = h("div", { class: "feedback" });

  const change = h("button", {
    text: t("Change…"),
    onclick: async () => {
      const before = info?.dir ?? "";
      changing = true;
      change.disabled = true;
      change.textContent = t("Moving…");
      clear(feedback);
      let result: WorkspaceChange | null = null;
      try {
        result = await Bridge.workspaceChange();
      } catch (err) {
        feedback.append(h("div", { class: "notice err", text: errText(err) }));
      }
      changing = false;
      change.disabled = false;
      change.textContent = t("Change…");
      if (result) {
        info = result.info;
        drawFolder();
        feedback.append(...changeReport(result, before));
      } else {
        refreshFolder();
      }
    },
  }) as HTMLButtonElement;
  const open = h("button", {
    text: t("Open"),
    onclick: () => void Bridge.workspaceOpen().catch((err) => {
      clear(feedback);
      feedback.append(h("div", { class: "notice err", text: errText(err) }));
    }),
  }) as HTMLButtonElement;

  function drawFolder() {
    if (!info) {
      path.textContent = "—";
      path.removeAttribute("title");
      meta.textContent = "";
      open.disabled = true;
      return;
    }
    path.textContent = shortPath(info.dir);
    path.setAttribute("title", info.dir);
    meta.textContent = [info.isDefault ? t("Default") : "", itemCount(info.items)].filter(Boolean).join(" · ");
    open.disabled = false;
  }

  function refreshFolder() {
    if (changing) return;
    void Bridge.workspaceInfo().then((fresh) => {
      info = fresh;
      drawFolder();
    });
  }

  // ── ffmpeg ───────────────────────────────────────────────────────────────
  let ff: FfmpegStatus | null = null;
  let progress: FfmpegDownloadEvent | null = null;
  const ffDot = h("span", {});
  const ffText = h("span", { class: "hint" });
  const ffPath = h("span", { class: "path" });
  const ffFeedback = h("div", { class: "feedback" });

  const download = h("button", {
    text: t("Download"),
    onclick: async () => {
      clear(ffFeedback);
      progress = { received: 0, total: null, done: false, error: null };
      drawFfmpeg();
      try {
        await Bridge.ffmpegDownload();
      } catch (err) {
        progress = null;
        ffFeedback.append(h("div", { class: "notice err", text: errText(err) }));
        drawFfmpeg();
      }
    },
  }) as HTMLButtonElement;
  const choose = h("button", {
    text: t("Choose ffmpeg…"),
    onclick: async () => {
      clear(ffFeedback);
      try {
        const fresh = await Bridge.ffmpegChoose();
        if (fresh) {
          ff = fresh;
          drawFfmpeg();
        }
      } catch (err) {
        ffFeedback.append(h("div", { class: "notice err", text: errText(err) }));
      }
    },
  }) as HTMLButtonElement;

  function drawFfmpeg() {
    const ready = !!ff?.path;
    const downloading = !!progress || (ff?.downloading ?? false);
    clear(ffDot);
    ffDot.append(statusDot(ready));
    if (downloading) {
      const got = progress?.received ?? 0;
      ffText.textContent = progress?.total
        ? t("Downloading… {received} MB of {total} MB", { received: megabytes(got), total: megabytes(progress.total) })
        : got > 0 ? t("Downloading ({megabytes} MB)…", { megabytes: megabytes(got) }) : t("Downloading…");
    } else if (ready) {
      const source = ff?.source === "downloaded" ? t("downloaded by the app")
        : ff?.source === "path" ? t("found on PATH")
          : ff?.source === "settings" ? t("chosen by you")
            : "";
      ffText.textContent = source ? `${t("Ready")} · ${source}` : t("Ready");
    } else {
      ffText.textContent = t("Not installed");
    }
    ffPath.textContent = ready ? shortPath(ff!.path!) : "";
    if (ready) ffPath.setAttribute("title", ff!.path!);
    else ffPath.removeAttribute("title");
    ffPath.style.display = ready ? "" : "none";
    download.style.display = !ready && (ff?.canDownload ?? false) ? "" : "none";
    download.disabled = downloading;
    choose.disabled = downloading;
  }

  function refreshFfmpeg() {
    void Bridge.ffmpegStatus().then((fresh) => {
      ff = fresh;
      drawFfmpeg();
    });
  }

  workspaceListener = {
    refresh: () => {
      if (!path.isConnected) return; // another page is on screen
      refreshFolder();
      if (!progress) refreshFfmpeg();
    },
    download: (e) => {
      if (e.error) {
        progress = null;
        clear(ffFeedback);
        ffFeedback.append(h("div", { class: "notice err", text: e.error }));
        refreshFfmpeg();
      } else if (e.done) {
        progress = null;
        refreshFfmpeg();
      } else {
        progress = e;
        drawFfmpeg();
      }
    },
  };

  drawFolder();
  drawFfmpeg();
  refreshFolder();
  refreshFfmpeg();

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Workspace") })),
    h("div", { class: "row" }, h("label", { text: t("Folder") }), path, meta),
    h("div", { class: "row" }, h("label", {}), change, open),
    feedback,
    h("div", { class: "hint", text: t("Files you drop on “Copy to workspace” are copied here, and the originals stay where they were. Changing the folder moves everything in it to the new one.") }),
    h("div", { class: "row" }, h("label", { text: "ffmpeg" }), ffDot, ffText, ffPath),
    h("div", { class: "row" }, h("label", {}), download, choose),
    ffFeedback,
    h("div", { class: "hint", text: t("Used to convert videos, audio and images. Free and open source; about 115 MB.") }),
  );
}

/** What a folder change did: how much moved, what stayed behind and why. */
function changeReport(r: WorkspaceChange, before: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  const dir = r.info.dir;
  if (r.moved > 0) {
    out.push(h("div", {
      class: "notice ok",
      text: tn("Moved {count} item to {dir}", "Moved {count} items to {dir}", r.moved, { dir }),
    }));
  }
  if (r.note) out.push(h("div", { class: "notice ok", text: r.note }));
  if (r.moved === 0 && !r.note && r.failed.length === 0) {
    out.push(h("div", { class: "notice ok", text: t("The workspace is now {dir}", { dir }) }));
  }
  if (r.failed.length > 0) {
    const n = r.failed.length;
    const box = h("div", { class: "notice warn" },
      h("div", {
        text: tn("{count} item couldn't be moved and stays in {dir}:", "{count} items couldn't be moved and stay in {dir}:", n, { dir: before }),
      }),
    );
    for (const f of r.failed) box.append(h("div", { text: `${f.name} — ${f.error}` }));
    out.push(box);
  }
  return out;
}
