// Settings → Features: a switch for every feature of the island. What is
// switched off goes into `disabledFeatures` and disappears from the island;
// everything else is on (see ./catalog.ts).

import { h } from "../views/dom";
import { t } from "../i18n/i18n";
import { anchor, toggle } from "../hub/ui";
import { FEATURE_GROUPS, featureOn, withFeature } from "./catalog";
import type { SettingsAccess } from "./access";

export function featuresSections(access: SettingsAccess): HTMLElement[] {
  return FEATURE_GROUPS.map((group) => {
    const list = h("div", { class: "feature-list" });
    for (const item of group.items) {
      const on = featureOn(access.get().disabledFeatures, item.id);
      const row = h("div", { class: on ? "feature-row" : "feature-row off" },
        h("div", { class: "text" },
          h("span", { class: "name", text: t(item.title) }),
          h("span", { class: "detail", text: t(item.detail) }),
        ),
      );
      const sw = toggle(on, (next) => {
        row.classList.toggle("off", !next);
        access.set({ disabledFeatures: withFeature(access.get().disabledFeatures ?? [], item.id, next) });
      });
      sw.setAttribute("aria-label", t(item.title));
      row.append(sw);
      list.append(row);
    }
    return anchor(group.anchor, h(
      "section",
      {},
      h("h2", {}, h("span", { text: t(group.title) })),
      h("div", { class: "hint", text: t(group.hint) }),
      list,
    ));
  });
}
