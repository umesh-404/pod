// Keyboard shortcuts: the pure logic (src/core/shortcuts.ts, mirroring the
// Mac's tests/ShortcutTests.swift) and what the island does with them
// (src/island/shortcuts.ts), driven through the real bridge.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calls, emit, sent } from "./tauri.mjs";
import {
  ALTGR_CHARACTERS, ISLAND_SHORTCUTS, KEY_NAMES, SHORTCUTS, SHORTCUT_TEXT, activeKeys, altGrClashes,
  displayKeys, duplicates, effective, formatKeys, islandKeyAction, normalizeKeys, parseKeys, recordPress,
} from "../src/core/shortcuts.ts";
import { registerShortcutHandlers, runGlobalShortcut, runIslandKey } from "../src/island/shortcuts.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";

/** The Mac actions this app keeps, in the Mac's order, with their Mac ids. */
const MAC_IDS = ["toggleIsland", "muteToggle", "desktopToggle", "wardrobeToggle"];
/** The workspace's own actions, after the Mac's. */
const WORKSPACE_IDS = ["openShelf", "newReminder", "quickNote", "screenshot", "smartClipboard"];
/** The actions that come with a key (the others wait for one in Settings). */
const withKeys = () => SHORTCUTS.filter((d) => d.defaultKeys);

// ── Defaults (testDefaultsExhaustive, testAllDefaultsHaveModifier, testNoDefaultDuplicates) ──

test("every Mac action has a default, in the Mac's order, with its Mac id", () => {
  assert.deepEqual(SHORTCUTS.map((d) => d.id), [...MAC_IDS, ...WORKSPACE_IDS]);
  for (const d of SHORTCUTS) assert.ok(SHORTCUT_TEXT[d.id], `${d.id} has no label`);
});

test("every default parses, is canonical and holds Ctrl+Alt", () => {
  for (const d of withKeys()) {
    const c = parseKeys(d.defaultKeys);
    assert.ok(c, `${d.id} default does not parse`);
    assert.ok(c.ctrl && c.alt && !c.meta, `${d.id} default is not Ctrl+Alt`);
    assert.equal(formatKeys(c), d.defaultKeys, `${d.id} default is not in canonical form`);
  }
});

test("no two defaults share a combination", () => {
  assert.deepEqual(duplicates(withKeys().map((d) => [d.id, d.defaultKeys])), new Set());
});

test("no default types a character with AltGr on the checked European layouts", () => {
  for (const layout of ["French (AZERTY)", "German (QWERTZ)", "Spanish", "Italian", "Portuguese", "Brazilian (ABNT2)"]) {
    assert.ok(ALTGR_CHARACTERS[layout], layout);
  }
  for (const d of withKeys()) {
    assert.deepEqual(altGrClashes(d.defaultKeys), [], `${d.id} = ${d.defaultKeys}`);
  }
  // The Mac's own letters would not have been safe.
  assert.deepEqual(altGrClashes("Ctrl+Alt+M"), ["German (QWERTZ)"]);
  assert.ok(altGrClashes("Ctrl+Alt+E").length >= 5);
  assert.ok(altGrClashes("Ctrl+Alt+0").includes("French (AZERTY)"));
  // Not Ctrl+Alt: not AltGr.
  assert.deepEqual(altGrClashes("Ctrl+Shift+E"), []);
});

test("the defaults are the same on both sides of the bridge", () => {
  const rust = readFileSync(new URL("../src-tauri/src/shortcuts.rs", import.meta.url), "utf8");
  const rows = [...rust.matchAll(/^\s*action\("(\w+)", "([^"]*)", (true|false), (true|false)\),/gm)]
    .map(([, id, keys, on, ported]) => ({ id, keys, on: on === "true", ported: ported === "true" }));
  assert.deepEqual(
    rows,
    SHORTCUTS.map((d) => ({ id: d.id, keys: d.defaultKeys, on: d.enabledByDefault, ported: d.ported })),
  );
});

test("the descriptions the Wayland portal shows are the labels Settings shows", () => {
  const rust = readFileSync(new URL("../src-tauri/src/shortcuts.rs", import.meta.url), "utf8");
  const rows = Object.fromEntries(
    [...rust.matchAll(/^\s*"(\w+)" => n_\("([^"]+)"\),/gm)].map(([, id, text]) => [id, text]),
  );
  assert.deepEqual(rows, Object.fromEntries(SHORTCUTS.map((d) => [d.id, SHORTCUT_TEXT[d.id]])));
});

// testEnabledByDefault
test("only the island toggle and the keyless are off by default, and every action is ported", () => {
  for (const d of SHORTCUTS) {
    assert.equal(d.enabledByDefault, d.id !== "toggleIsland" && d.defaultKeys !== "", d.id);
    assert.equal(d.ported, true, d.id);
  }
  assert.deepEqual(activeKeys({}).map(([id]) => id), ["muteToggle", "desktopToggle", "wardrobeToggle", "openShelf"]);
  // Among the workspace's, only the shelf comes with a key.
  assert.deepEqual(WORKSPACE_IDS.filter((id) => SHORTCUTS.find((d) => d.id === id).defaultKeys), ["openShelf"]);
  assert.equal(SHORTCUTS.find((d) => d.id === "openShelf").defaultKeys, "Ctrl+Alt+Space");
  // The Mac's ⌃⌥D, on the same letter.
  assert.equal(SHORTCUTS.find((d) => d.id === "desktopToggle").defaultKeys, "Ctrl+Alt+D");
});

// ── Parsing and formatting (testCarbonModifiers, testDisplayString, testKeyCodeToString) ──

test("modifiers parse one by one and all together", () => {
  assert.deepEqual(parseKeys("Ctrl+Shift+N"), { ctrl: true, alt: false, shift: true, meta: false, key: "N" });
  assert.deepEqual(parseKeys("Ctrl+Alt+A"), { ctrl: true, alt: true, shift: false, meta: false, key: "A" });
  assert.deepEqual(parseKeys("Super+Shift+Alt+Ctrl+k"), { ctrl: true, alt: true, shift: true, meta: true, key: "K" });
  // The spellings Rust accepts.
  assert.equal(normalizeKeys("control+option+arrowright"), "Ctrl+Alt+Right");
  assert.equal(normalizeKeys("CmdOrCtrl+Alt+KeyQ"), "Ctrl+Alt+Q");
  assert.equal(normalizeKeys("Ctrl+Alt+Digit7"), "Ctrl+Alt+7");
  assert.equal(normalizeKeys("Ctrl+Alt+]"), "Ctrl+Alt+BracketRight");
});

test("a bare key, Shift alone, a modifier with no key, or nonsense is not a shortcut", () => {
  for (const bad of ["", "A", "Shift+A", "Ctrl+Alt", "Ctrl+Alt+", "Ctrl+Alt+Nope", "A+Ctrl", "Ctrl+A+B", "Ctrl+Escape"]) {
    assert.equal(parseKeys(bad), null, JSON.stringify(bad));
  }
});

test("what a person reads", () => {
  assert.equal(displayKeys("Ctrl+Shift+N"), "Ctrl+Shift+N");
  assert.equal(displayKeys("Ctrl+Alt+Space"), "Ctrl+Alt+Space");
  assert.equal(displayKeys("Ctrl+Alt+Right"), "Ctrl+Alt+→");
  assert.equal(displayKeys("Ctrl+Alt+Left"), "Ctrl+Alt+←");
  assert.equal(displayKeys("Super+Comma"), "Win+,");
  assert.equal(displayKeys("Ctrl+Alt+BracketLeft"), "Ctrl+Alt+[");
  assert.equal(displayKeys(""), "—");
  // Each modifier once.
  assert.equal(displayKeys("Ctrl+Ctrl+Alt+A").match(/Ctrl/g).length, 1);
});

test("every key name survives a round trip", () => {
  for (const key of KEY_NAMES) {
    assert.equal(normalizeKeys(`Ctrl+Alt+${key}`), `Ctrl+Alt+${key}`, key);
  }
});

// ── Conflicts (testDuplicateDetection) ───────────────────────────────────────

test("duplicates flag both actions, and only the same modifiers and key", () => {
  assert.deepEqual(duplicates([]), new Set());
  assert.deepEqual(duplicates([["muteToggle", "Ctrl+Alt+S"]]), new Set());
  assert.deepEqual(duplicates([["muteToggle", "Ctrl+Alt+S"], ["desktopToggle", "Ctrl+Alt+D"]]), new Set());
  assert.deepEqual(
    duplicates([["muteToggle", "Ctrl+Alt+S"], ["desktopToggle", "ctrl+alt+s"]]),
    new Set(["muteToggle", "desktopToggle"]),
  );
  assert.deepEqual(duplicates([["muteToggle", "Ctrl+Alt+S"], ["desktopToggle", "Ctrl+Shift+S"]]), new Set());
});

// ── Stored bindings (testLoadSaveRoundTrip) ───────────────────────────────────

test("a stored binding wins, the rest keep their default, and off ones hold no keys", () => {
  const stored = {
    muteToggle: { keys: "Ctrl+Alt+K", enabled: true },
    desktopToggle: { keys: "Ctrl+Alt+D", enabled: false },
    toggleIsland: { keys: "Ctrl+Alt+N", enabled: true },
  };
  const mute = SHORTCUTS.find((d) => d.id === "muteToggle");
  assert.deepEqual(effective(mute, stored), { keys: "Ctrl+Alt+K", enabled: true });
  assert.deepEqual(effective(mute, undefined), { keys: "Ctrl+Alt+S", enabled: true });
  const ids = activeKeys(stored).map(([id]) => id);
  assert.ok(ids.includes("toggleIsland"));
  assert.ok(!ids.includes("desktopToggle"));
  // Same JSON shape as Rust's Bindings.
  assert.deepEqual(JSON.parse(JSON.stringify(stored)).muteToggle, { keys: "Ctrl+Alt+K", enabled: true });
  assert.deepEqual(DEFAULT_SETTINGS.shortcuts, {});
});

// ── Recording a press ─────────────────────────────────────────────────────────

const press = (over) => ({
  key: "", code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over,
});

test("the recorder turns a press into canonical keys", () => {
  assert.deepEqual(recordPress(press({ key: " ", code: "Space", ctrlKey: true, altKey: true })),
    { kind: "keys", keys: "Ctrl+Alt+Space" });
  assert.deepEqual(recordPress(press({ key: "ArrowRight", code: "ArrowRight", ctrlKey: true, altKey: true })),
    { kind: "keys", keys: "Ctrl+Alt+Right" });
  // AZERTY: the key labelled A sits where QWERTY has Q. The label wins, as it
  // does for RegisterHotKey.
  assert.deepEqual(recordPress(press({ key: "a", code: "KeyQ", ctrlKey: true, altKey: true })),
    { kind: "keys", keys: "Ctrl+Alt+A" });
  assert.deepEqual(recordPress(press({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true })),
    { kind: "keys", keys: "Ctrl+Shift+K" });
  assert.deepEqual(recordPress(press({ key: "F9", code: "F9", metaKey: true })),
    { kind: "keys", keys: "Super+F9" });
});

test("the recorder waits for a key, cancels, clears, and refuses what can't be a shortcut", () => {
  assert.deepEqual(recordPress(press({ key: "Control", code: "ControlLeft", ctrlKey: true })), { kind: "pending" });
  assert.deepEqual(recordPress(press({ key: "AltGraph", code: "AltRight", ctrlKey: true, altKey: true })), { kind: "pending" });
  assert.deepEqual(recordPress(press({ key: "Escape", code: "Escape" })), { kind: "cancel" });
  assert.deepEqual(recordPress(press({ key: "Backspace", code: "Backspace" })), { kind: "clear" });
  assert.deepEqual(recordPress(press({ key: "a", code: "KeyA" })), { kind: "needsModifier" });
  assert.deepEqual(recordPress(press({ key: "A", code: "KeyA", shiftKey: true })), { kind: "needsModifier" });
  assert.deepEqual(recordPress(press({ key: "Unidentified", code: "Lang1", ctrlKey: true })), { kind: "unsupported" });
});

test("a Ctrl+Alt press that types a character on this keyboard is refused", () => {
  // German: AltGr+E = €, AltGr+Q = @. French: AltGr+0 = @.
  assert.deepEqual(recordPress(press({ key: "€", code: "KeyE", ctrlKey: true, altKey: true })),
    { kind: "typesCharacter", typed: "€", keys: "Ctrl+Alt+E" });
  assert.deepEqual(recordPress(press({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true })),
    { kind: "typesCharacter", typed: "@", keys: "Ctrl+Alt+Q" });
  assert.deepEqual(recordPress(press({ key: "@", code: "Digit0", ctrlKey: true, altKey: true })),
    { kind: "typesCharacter", typed: "@", keys: "Ctrl+Alt+0" });
  assert.equal(recordPress(press({ key: "Dead", code: "BracketLeft", ctrlKey: true, altKey: true })).kind, "typesCharacter");
  // Ctrl+Shift is never AltGr.
  assert.deepEqual(recordPress(press({ key: "€", code: "KeyE", ctrlKey: true, shiftKey: true })),
    { kind: "keys", keys: "Ctrl+Shift+E" });
});

// ── In the island ─────────────────────────────────────────────────────────────

test("Ctrl stands in for the Mac's Cmd inside the island", () => {
  const ctrl = (key, code = "") => press({ key, code, ctrlKey: true });
  assert.deepEqual(islandKeyAction(ctrl("p", "KeyP")), { kind: "pin" });
  assert.deepEqual(islandKeyAction(ctrl("P", "KeyP")), { kind: "pin" });
  assert.deepEqual(islandKeyAction(ctrl(",", "Comma")), { kind: "settings" });
  // The keys of the pills, the lists, the diff and the chat are gone.
  for (const [key, code] of [["ArrowRight", ""], ["ArrowDown", "ArrowDown"], ["1", "Digit1"], ["o", "KeyO"], ["e", "KeyE"], ["k", "KeyK"]]) {
    assert.equal(islandKeyAction(ctrl(key, code)), null, key);
  }
  // Anything with another modifier, or no Ctrl, is left alone.
  assert.equal(islandKeyAction(press({ key: "p", code: "KeyP", ctrlKey: true, altKey: true })), null);
  assert.equal(islandKeyAction(press({ key: "p", code: "KeyP" })), null);
  assert.deepEqual(ISLAND_SHORTCUTS.map((s) => s.keys), ["Ctrl+,", "Ctrl+P", "Esc"]);
});

// ── What the island does ──────────────────────────────────────────────────────

let did;
const host = {
  alert: (v) => did.push(`alert:${v}`),
  collapse: () => did.push("collapse"),
  emote: (e) => did.push(`emote:${e}`),
  setPinned: (on) => did.push(`pin:${on}`),
  takeKeyboard: () => did.push("keyboard"),
  wardrobeAnywhere: () => did.push("wardrobe"),
  canLeaveIsland: () => desktopSupported,
  flyOutOrHome: () => did.push("desktop"),
};
let desktopSupported = true;
const resume = () => did.push("resume");
// The island listens on `window`, which here is the bare global object.
const listeners = [];
globalThis.addEventListener = (type, fn, capture) => listeners.push({ type, fn, capture });
registerShortcutHandlers(host, resume);

beforeEach(() => {
  did = [];
  calls.length = 0;
  State.mode = "hidden";
  State.view = "overview";
  State.isPinned = false;
  State.stateOverride = null;
  State.settings = { ...DEFAULT_SETTINGS };
  State.mochiOnDesktop = false;
  desktopSupported = true;
});

test("the wardrobe shortcut's own event opens the wardrobe", () => {
  emit("open-wardrobe", null);
  assert.deepEqual(did, ["resume", "wardrobe"]);
});

test("a global shortcut arrives as an event", () => {
  emit("shortcut", "toggleIsland");
  assert.deepEqual(did, ["resume", "alert:overview", "keyboard"]);
});

test("island keys are read before a field sees them, and only while open", () => {
  const keydown = listeners.find((l) => l.type === "keydown");
  assert.equal(keydown.capture, true);
  const ev = (over) => {
    const e = { ...press(over), target: null, stopped: false, prevented: false };
    e.preventDefault = () => { e.prevented = true; };
    e.stopPropagation = () => { e.stopped = true; };
    return e;
  };
  const hidden = ev({ key: "p", code: "KeyP", ctrlKey: true });
  keydown.fn(hidden);
  assert.equal(hidden.prevented, false);

  State.mode = "expanded";
  const pin = ev({ key: "p", code: "KeyP", ctrlKey: true });
  keydown.fn(pin);
  assert.ok(pin.prevented && pin.stopped);
  assert.deepEqual(did, ["pin:true"]);

  // Plain typing is left alone.
  const plain = ev({ key: "k", code: "KeyK" });
  keydown.fn(plain);
  assert.equal(plain.prevented, false);
});

test("the island toggle opens with the keyboard, and closes an open island", () => {
  runGlobalShortcut(host, "toggleIsland", resume);
  assert.deepEqual(did, ["resume", "alert:overview", "keyboard"]);
  did = [];
  State.mode = "expanded";
  runGlobalShortcut(host, "toggleIsland", resume);
  assert.deepEqual(did, ["collapse"]);
});

test("mute flips the sound, saves it, and Mochi reacts", () => {
  runGlobalShortcut(host, "muteToggle", resume);
  assert.equal(State.settings.soundEnabled, false);
  assert.equal(sent("save_settings").at(-1).settings.soundEnabled, false);
  runGlobalShortcut(host, "muteToggle", resume);
  assert.equal(State.settings.soundEnabled, true);
  assert.deepEqual(did, ["emote:annoyed", "emote:happy"]);
});

test("the desktop shortcut sends Mochi out, lifting Pause, and brings him home", () => {
  runGlobalShortcut(host, "desktopToggle", resume);
  assert.deepEqual(did, ["resume", "desktop"]);
  // Out there already: home, and Pause stays as it is.
  did = [];
  State.mochiOnDesktop = true;
  runGlobalShortcut(host, "desktopToggle", resume);
  assert.deepEqual(did, ["desktop"]);
  assert.deepEqual(calls, []);
});

test("where Mochi can't leave the island (GNOME on Wayland), he says so", () => {
  desktopSupported = false;
  runGlobalShortcut(host, "desktopToggle", resume);
  assert.deepEqual(did, ["emote:annoyed"]);
});

test("the desktop shortcut arrives like the others, and runs from the command line", () => {
  emit("shortcut", "desktopToggle");
  assert.deepEqual(did, ["resume", "desktop"]);
  const rust = readFileSync(new URL("../src-tauri/src/shortcuts.rs", import.meta.url), "utf8");
  assert.match(rust, /from_args\(&args\(&\["pod", "--shortcut", "desktopToggle"\]\)\), Some\("desktopToggle"\)/);
});

test("actions that aren't the island's do nothing here", () => {
  // The agent and chat shortcuts of earlier versions may still sit in settings.json.
  for (const id of ["wardrobeToggle", "openChat", "goToAlert", "jumpToTerminal", "nextPill", "nonsense"]) {
    runGlobalShortcut(host, id, resume);
  }
  assert.deepEqual(did, []);
  assert.deepEqual(calls, []);
});

test("island keys: settings and pin", () => {
  runIslandKey(host, { kind: "settings" });
  assert.equal(sent("open_settings_window").length, 1);
  runIslandKey(host, { kind: "pin" });
  assert.deepEqual(did, ["pin:true"]);
});

// ── The workspace's shortcuts ─────────────────────────────────────────────────

test("the workspace shortcuts open their tab with the keyboard, or refuse when switched off", () => {
  const tabs = [];
  const withTabs = { ...host, openTab: (id, intent) => { tabs.push([id, intent ?? null]); did.push(`tab:${id}`); } };
  runGlobalShortcut(withTabs, "openShelf", resume);
  runGlobalShortcut(withTabs, "newReminder", resume);
  runGlobalShortcut(withTabs, "quickNote", resume);
  runGlobalShortcut(withTabs, "smartClipboard", resume);
  assert.deepEqual(tabs, [["shelf", null], ["reminders", "new"], ["notes", "new"], ["tools", "clipboard"]]);
  assert.deepEqual(did.slice(0, 3), ["resume", "tab:shelf", "keyboard"]);

  // The shelf's shortcut closes the island when it is already on the shelf.
  did = [];
  State.mode = "expanded";
  State.view = "overview";
  State.tab = "shelf";
  runGlobalShortcut(withTabs, "openShelf", resume);
  assert.deepEqual(did, ["collapse"]);

  did = [];
  State.mode = "hidden";
  State.settings = { ...DEFAULT_SETTINGS, disabledFeatures: ["notes"] };
  runGlobalShortcut(withTabs, "quickNote", resume);
  assert.deepEqual(did, ["emote:annoyed"]);
});

test("the screenshot shortcut asks Rust for the snipping overlay", () => {
  runGlobalShortcut(host, "screenshot", resume);
  assert.deepEqual(did, ["resume"]);
  assert.equal(sent("capture_to_shelf").length, 1);
});
