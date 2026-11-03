// Language changes must update the existing sidebar as well as its page.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { installFakeDom } from "./fakedom.mjs";
import { calls, emit, sent } from "./tauri.mjs";

// The shell imports its stylesheet; layout is checked in the browser.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".css")) {
      return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    // The canvas helper has a parameter property beyond Node's type stripping.
    if (url.endsWith("/hub/hero.ts")) {
      const { outputText } = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      });
      return { format: "module", source: outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const dom = installFakeDom();
// Keep canvas animation asleep: these tests exercise the shell's DOM only.
document.visibilityState = "hidden";
document.addEventListener = () => {};
document.documentElement = { dataset: {} };
window.addEventListener = () => {};

const { h } = await import("../src/views/dom.ts");
const { onLanguageChange, setLanguage, t } = await import("../src/i18n/i18n.ts");
const { NOTCH_PAGES, startHub } = await import("../src/hub/shell.ts");
const pages = NOTCH_PAGES;
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  setLanguage("en");
  calls.length = 0;
});

async function openHub() {
  const root = dom.root();
  const hub = await startHub(root, {
    version: "test",
    renderPage: async (page, container) => {
      container.append(h("h1", { text: pages.find((p) => p.id === page).title() }));
    },
  });
  // The fake DOM keeps no input value: the settings search field starts empty.
  for (const input of root.find(".hub-search-input")) input.value = "";
  // The settings entry point wires language changes to this public method.
  const off = onLanguageChange(() => hub.redraw());
  return { root, hub, off, buttons: root.find(".hub-item") };
}

test("language redraw relabels sidebar nodes and preserves selection and navigation", async () => {
  const { root, hub, off, buttons } = await openHub();
  try {
    const logo = root.find(".hub-brand")[0].find("CANVAS")[0];
    const labels = buttons.map((button) => button.find("SPAN")[0]);
    const groups = root.find(".hub-group");
    const shortcuts = pages.findIndex((p) => p.id === "shortcuts");
    buttons[shortcuts].fire("click");
    await settle();
    assert.equal(hub.current(), "shortcuts");
    assert.equal(root.find("H1")[0].textContent, "Shortcuts");
    calls.length = 0;

    for (const language of ["fr", "ar", "en"]) {
      setLanguage(language);
      await settle();
      assert.deepEqual(root.find(".hub-item"), buttons, "keep the existing buttons");
      assert.deepEqual(buttons.map((button) => button.find("SPAN")[0]), labels);
      assert.deepEqual(buttons.map((button) => button.textContent), pages.map((page) => page.title()));
      assert.equal(groups.length, 1);
      assert.equal(groups[0].textContent, t("Notch"));
      assert.equal(root.find(".hub-brand")[0].find("CANVAS")[0], logo);
      assert.equal(hub.current(), "shortcuts");
      assert.deepEqual(buttons.filter((button) => button.classList.contains("on")), [buttons[shortcuts]]);
      assert.equal(root.find("H1")[0].textContent, t("Shortcuts"));
      assert.equal(document.documentElement.dataset.dir, language === "ar" ? "rtl" : "ltr");
    }
    assert.deepEqual(calls, [], "redrawing must not save settings or request data");
    buttons[0].fire("click");
    await settle();
    assert.equal(hub.current(), "general", "existing click listeners still work");
  } finally {
    off();
  }
});

test("the sidebar uses the selected language on its first render", async () => {
  setLanguage("es");
  const { root, off, buttons } = await openHub();
  try {
    assert.deepEqual(buttons.map((button) => button.textContent), pages.map((page) => page.title()));
    assert.equal(root.find(".hub-group")[0].textContent, t("Notch"));
  } finally {
    off();
  }
});
