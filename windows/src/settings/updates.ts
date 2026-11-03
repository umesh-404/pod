// Settings → General → Updates: checking on its own (on by default), installing
// on its own (on by default, per-user setup.exe installs only: Pod downloads and
// verifies the update, then installs it while the user is away), "Check now" (a
// click, so it works with checks off), and "Install X" once a new version is out.

import { Bridge } from "../core/bridge";
import { NO_UPDATE, isBusy, type UpdateStatus } from "../core/update";
import { h } from "../views/dom";
import { t } from "../i18n/i18n";

type Toggle = (on: boolean, onChange: (v: boolean) => void) => HTMLElement;

/** The rows on screen, told about "update-status" (listened to once in main.ts). */
export let updatesListener: ((status: UpdateStatus) => void) | null = null;

export function updateRows(toggle: Toggle, version: string): HTMLElement[] {
  let status: UpdateStatus = { ...NO_UPDATE, current: version };
  const sw = toggle(false, (on) => void Bridge.updateSetConsent(on));
  const autoSw = toggle(false, (on) => void Bridge.updateSetAutoInstall(on));
  const autoRow = h("div", { class: "row" },
    h("label", {}),
    autoSw,
    h("span", { class: "hint", text: t("Install updates automatically") }),
  );
  const ready = h("span", { class: "hint" });
  const readyRow = h("div", { class: "row" }, h("label", {}), ready);
  const install = h("button", {
    onclick: () => void (status.canInstall ? Bridge.updateShow() : Bridge.updateOpenPage()),
  }) as HTMLButtonElement;
  const check = h("button", {
    text: t("Check now"),
    onclick: async () => {
      check.disabled = true;
      feedback.textContent = "";
      const fresh = await Bridge.updateCheck();
      if (fresh) status = fresh;
      draw();
    },
  }) as HTMLButtonElement;
  const feedback = h("span", { class: "hint" });
  const footer = h("span", { class: "hint", style: "flex:1 1 0;min-width:0" });
  const current = h("span", { class: "hint" });

  function draw() {
    sw.classList.toggle("on", status.consent === true);
    sw.setAttribute("aria-pressed", String(status.consent === true));
    autoSw.classList.toggle("on", status.autoInstall);
    autoSw.setAttribute("aria-pressed", String(status.autoInstall));
    // Only a per-user setup.exe install can update itself without asking.
    autoRow.style.display = status.autoPossible && status.consent === true ? "" : "none";
    readyRow.style.display = status.ready && status.autoInstall ? "" : "none";
    if (status.ready) ready.textContent = t("{version} is ready. It installs by itself the next time you step away.", { version: status.ready });
    const r = status.latest;
    install.style.display = r ? "" : "none";
    if (r) {
      install.textContent = status.canInstall
        ? t("Install {version}", { version: r.version })
        : t("Get {version} on GitHub", { version: r.version });
    }
    check.disabled = status.check === "checking" || isBusy(status.phase);
    feedback.textContent =
      status.check === "upToDate" ? t("Pod is up to date")
        : status.check === "unreachable" ? t("Couldn't reach GitHub")
          : "";
    footer.textContent = status.platform === "linux"
      ? t("Pod looks at its own releases on GitHub a few times a day and tells you when one is out. Update it the way you installed it: AppImage, .deb, .rpm or your package manager.")
      : t("Pod looks for new versions on GitHub a few times a day. An update is installed only once its SHA-256 matches the one GitHub publishes, and on its own only while you're away from the computer: Pod then restarts by itself.");
    current.textContent = t("You have {version}", { version: status.current || version });
  }

  updatesListener = (fresh) => {
    status = fresh;
    draw();
  };
  void Bridge.updateStatus().then((fresh) => {
    if (fresh) updatesListener?.(fresh);
  });
  draw();

  return [
    h("div", { class: "row" },
      h("label", { text: t("Updates") }),
      sw,
      h("span", { class: "hint", text: t("Check for new versions automatically") }),
    ),
    autoRow,
    readyRow,
    h("div", { class: "row" }, h("label", {}), install, check, feedback),
    h("div", { class: "row" }, h("label", {}), footer),
    h("div", { class: "row" }, h("label", {}), current),
  ];
}
