// The island itself (src/island/island.ts), built on the fake DOM against the
// Tauri mock: how its state machine, its holds and its views fit together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { internals } from "./tauri.mjs";

installFakeDom();
// What the webview has and the fake DOM doesn't: the island only registers
// listeners on `window` and asks for frames, which these tests drive themselves.
globalThis.requestAnimationFrame = () => 0; // frames are not run here
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
globalThis.dispatchEvent ??= () => true;
globalThis.innerWidth ??= 720;
const proto = Object.getPrototypeOf(document.createElement("canvas"));
proto.getContext ??= () => null;
internals.metadata ??= { currentWindow: { label: "island" }, currentWebview: { windowLabel: "island", label: "island" } };

const { Island } = await import("../src/island/island.ts");
const { FileActions } = await import("../src/island/file-actions.ts");
const { State } = await import("../src/core/state.ts");

const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

test("a card folded away while it waits for an answer opens again when the island does", async () => {
  const island = new Island(document.createElement("div"));
  await settle();
  // Files dropped on Resize: the card asks for a size and holds the island.
  FileActions.current.drop("resize", ["C:\\photos\\a.png"]);
  assert.equal(State.mode, "expanded");
  assert.equal(State.view, "fileAction");

  // Escape folds the island; the card still waits.
  island.collapse();
  assert.equal(State.mode, "compact");
  assert.equal(State.fileAction?.kind, "resize");

  // A click on the compact island brings the card back, not the overview.
  island.fsm.click();
  assert.equal(State.mode, "expanded");
  assert.equal(State.view, "fileAction");

  // Answered (Cancel), the island opens on its usual view again.
  FileActions.current.close();
  island.fsm.click();
  assert.equal(State.view, State.defaultView());
});

test("paused, the hidden island stays hidden: the wake strip and reveals don't bring it back", async () => {
  const root = document.createElement("div");
  const island = new Island(root);
  await settle();
  // Tray → Pause (main.ts): hidden, and the state machine told.
  State.paused = true;
  island.fsm.paused = true;
  island.fsm.forceHome();
  island.fsm.forceHidden();
  assert.equal(State.mode, "hidden");

  const wakeStrip = root.childNodes[0]; // the wake strip, then the island (Island.build)
  for (const fn of wakeStrip.listeners.get("mouseenter") ?? []) fn({ type: "mouseenter" });
  island.reveal(); // a reminder fell due
  island.revealSilently(); // music started, or the window uncovered the notch
  assert.equal(State.mode, "hidden");

  // Resumed (tray, a shortcut): it comes back.
  State.paused = false;
  island.fsm.paused = false;
  island.reveal();
  assert.equal(State.mode, "compact");
});
