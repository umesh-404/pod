import test from "node:test";
import assert from "node:assert/strict";
import { normalize, words, match, searchSettings, SETTINGS_ENTRIES } from "../src/hub/search.ts";

test("SettingsSearch - words normalization and splitting", () => {
  assert.deepEqual(words("  Réglage   SON "), ["reglage", "son"]);
  assert.deepEqual(words("   "), []);
  assert.deepEqual(words("général"), ["general"]);
  assert.deepEqual(words("Türkçe Ayarlar"), ["turkce", "ayarlar"]);
  assert.deepEqual(words("Häufige Fragen"), ["haufige", "fragen"]);
});

test("SettingsSearch - match against box, title, and labels (Mac contract parity)", () => {
  const sound = {
    title: "Son",
    page: "Général",
    labels: ["Activer les sons", "Volume", "Ouvrir le dossier des sons"],
  };

  const m = (q) => match(words(q), sound.title, sound.page, sound.labels);

  // The box by its title or its page, whatever the accents and the case.
  assert.deepEqual(m("son"), { kind: "box" });
  assert.deepEqual(m("GENERAL"), { kind: "box" });
  assert.deepEqual(m("général son"), { kind: "box" });

  // A setting inside it.
  assert.deepEqual(m("volu"), { kind: "label", label: "Volume" });
  assert.deepEqual(m("dossier"), { kind: "label", label: "Ouvrir le dossier des sons" });

  // Every word somewhere; the label with most of them.
  assert.deepEqual(m("ouvrir dossier son"), { kind: "label", label: "Ouvrir le dossier des sons" });
  assert.deepEqual(m("volume general"), { kind: "label", label: "Volume" });

  // Not there.
  assert.equal(m("micro"), null);
  assert.equal(m("volume micro"), null, "every word must be found");
  assert.equal(m(""), null);
});

test("SettingsSearch - searchSettings searches the island's settings", () => {
  const pageTitles = { general: "General", notch: "Notch", features: "Features", shortcuts: "Shortcuts" };
  const getPageTitle = (p) => pageTitles[p] ?? p;

  // Search by box name
  const resSound = searchSettings("sound", getPageTitle);
  assert.ok(resSound.some((h) => h.entry.id === "general.sound"));

  // Search by term inside box
  const resVolume = searchSettings("volume", getPageTitle);
  assert.ok(resVolume.some((h) => h.entry.id === "general.sound"));

  // Search by page title
  const resShortcuts = searchSettings("shortcuts", getPageTitle);
  assert.ok(resShortcuts.some((h) => h.entry.page === "shortcuts"));

  // The pages that are gone are not searched any more.
  for (const gone of ["handsfree", "banned", "Ollama", "Stripe"]) {
    assert.deepEqual(searchSettings(gone, getPageTitle), [], gone);
  }

  // Empty query returns empty array
  assert.deepEqual(searchSettings("", getPageTitle), []);
  assert.deepEqual(searchSettings("   ", getPageTitle), []);

  // Unknown query returns empty array
  assert.deepEqual(searchSettings("nonexistentgibberishqueryxyz", getPageTitle), []);
});

test("SettingsSearch - SETTINGS_ENTRIES integrity and completeness", () => {
  assert.ok(SETTINGS_ENTRIES.length >= 10, "must include complete set of hub settings");
  const ids = new Set();
  for (const entry of SETTINGS_ENTRIES) {
    assert.ok(entry.id, "every entry must have an id");
    assert.ok(!ids.has(entry.id), `duplicate entry id: ${entry.id}`);
    ids.add(entry.id);
    assert.ok(["general", "notch", "features", "shortcuts"].includes(entry.page), `entry ${entry.id} must be on a page that exists`);
    assert.ok(entry.title, `entry ${entry.id} must define a title`);
    assert.ok(Array.isArray(entry.terms), `entry ${entry.id} must define terms array`);
  }
});

test("SettingsSearch - finds the Features and Notch rows", () => {
  const pageTitles = { general: "General", notch: "Notch", features: "Features", shortcuts: "Shortcuts" };
  const getPageTitle = (p) => pageTitles[p] ?? p;
  const ids = (q) => searchSettings(q, getPageTitle).map((h) => h.entry.id);

  assert.ok(ids("zip").includes("features.drop"));
  assert.ok(ids("pdf").includes("features.drop"));
  assert.ok(ids("reminders").includes("features.tabs"));
  assert.ok(ids("clipboard").includes("features.tools"));
  assert.ok(ids("features").includes("features.drop"), "by the page's title");
  assert.ok(ids("calendar").includes("notch.calendar"));
  assert.ok(ids("now playing").includes("notch.sides"));
  assert.ok(ids("seconds").includes("notch.sides"));
  assert.ok(ids("deadlines").includes("notch.sides"));
  assert.ok(ids("left side").includes("notch.sides"));
  assert.ok(ids("preview").includes("notch.preview"));
  assert.ok(ids("break").includes("notch.focus"));
  // A label inside a box is reported with it.
  const hit = searchSettings("glance", getPageTitle).find((h) => h.entry.id === "notch.sides");
  assert.equal(hit?.label, "System glance");
});

test("SettingsSearch - every box of the Features and Notch pages is searchable", async () => {
  const { FEATURE_GROUPS } = await import("../src/settings/catalog.ts");
  const ids = new Set(SETTINGS_ENTRIES.map((e) => e.id));
  for (const g of FEATURE_GROUPS) assert.ok(ids.has(g.anchor), g.anchor);
  for (const id of ["notch.preview", "notch.sides", "notch.calendar", "notch.focus"]) assert.ok(ids.has(id), id);
});
