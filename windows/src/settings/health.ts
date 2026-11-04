// Settings → General → Health: what the self-repair found the last time it
// looked (src-tauri/src/heal.rs) — each check's state, what it repaired lately
// — and "Check now". Pod repairs its own parts by itself; what belongs to
// Windows or another program is only shown here.

import { Bridge, type HealthReport } from "../core/bridge";
import { h, clear } from "../views/dom";
import { language, t } from "../i18n/i18n";
import { statusDot } from "./parts";

/** The section on screen, told about "heal-status" (listened to once in main.ts). */
export let healthListener: ((report: HealthReport) => void) | null = null;

function when(ms: number): string {
  try {
    return new Date(ms).toLocaleString(language(), { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return new Date(ms).toLocaleString();
  }
}

/** Green for fine or repaired, red for what needs the user, grey for skipped. */
function dot(status: string): HTMLElement {
  if (status === "skipped") return h("i", { class: "dot", style: "background:#9ca3af" });
  return statusDot(status !== "warning");
}

export function healthSection(): HTMLElement {
  let report: HealthReport | null = null;
  const last = h("span", { class: "hint" });
  const list = h("div", {});
  const repairs = h("div", {});
  const off = h("div", { class: "hint" });
  const check = h("button", {
    text: t("Check now"),
    onclick: async () => {
      check.disabled = true;
      last.textContent = t("Checking…");
      const fresh = await Bridge.healCheck();
      if (fresh) report = fresh;
      draw();
    },
  }) as HTMLButtonElement;

  function draw() {
    const r = report;
    check.disabled = r?.checking ?? false;
    last.textContent = r?.checking ? t("Checking…")
      : r?.lastCheck ? t("Last check: {time}", { time: when(r.lastCheck) })
        : t("Not checked yet");
    off.textContent = r && !r.enabled ? t("Self-repair is off. Pod checks only when you click Check now.") : "";
    off.style.display = r && !r.enabled ? "" : "none";
    clear(list);
    for (const c of r?.checks ?? []) {
      list.append(h("div", { class: "row health-row" },
        h("label", { text: c.title }),
        dot(c.status),
        h("span", { class: "hint", text: c.detail || t("No problem found") }),
      ));
    }
    clear(repairs);
    if (r && r.repairs.length > 0) {
      const box = h("div", { class: "notice ok" }, h("div", { text: t("Recent repairs") }));
      for (const fix of r.repairs) box.append(h("div", { text: `${when(fix.at)} — ${fix.text}` }));
      repairs.append(box);
    }
  }

  healthListener = (fresh) => {
    if (!last.isConnected) return; // another page is on screen
    report = fresh;
    draw();
  };
  void Bridge.healStatus().then((fresh) => {
    if (fresh) {
      report = fresh;
      draw();
    }
  });
  draw();

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Health") })),
    h("div", { class: "row" }, h("label", {}), check, last),
    off,
    list,
    repairs,
    h("div", { class: "hint", text: t("Pod checks its own files at launch and every few hours while you're away, and fixes what broke: a missing shelf folder, a damaged settings file or ffmpeg download, files left by an interrupted job. It never touches your own files; anything outside Pod is only shown here.") }),
  );
}
