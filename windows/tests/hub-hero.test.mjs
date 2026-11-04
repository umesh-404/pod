// The Pod window's live Stew (hub/hero.ts liveMochi) listens to the window's
// pointer for his eyes. The Notch page builds a new one on every visit, so the
// listener must leave with his canvas, not pile up one per visit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { installFakeDom } from "./fakedom.mjs";

registerHooks({
  load(url, context, nextLoad) {
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

installFakeDom();
// The animation loop stays asleep: only the listeners are looked at here.
document.visibilityState = "hidden";
document.addEventListener = () => {};
const moves = new Set();
window.addEventListener = (type, fn) => { if (type === "pointermove") moves.add(fn); };
window.removeEventListener = (type, fn) => { if (type === "pointermove") moves.delete(fn); };

const { liveMochi } = await import("../src/hub/hero.ts");

test("live Stew: his window listener goes once his canvas is gone", () => {
  const canvas = document.createElement("canvas");
  canvas.isConnected = true;
  liveMochi(canvas);
  assert.equal(moves.size, 1);
  const [onMove] = moves;
  onMove({ clientX: 10, clientY: 10 });
  assert.equal(moves.size, 1, "kept while he is on the page");

  // The page changed: the next move lets him go.
  canvas.isConnected = false;
  onMove({ clientX: 20, clientY: 20 });
  assert.equal(moves.size, 0);
});

test("live Stew: one built but never put on a page is not let go early", () => {
  moves.clear();
  const canvas = document.createElement("canvas");
  canvas.isConnected = false;
  liveMochi(canvas);
  const [onMove] = moves;
  onMove({ clientX: 1, clientY: 1 });
  assert.equal(moves.size, 1);
});
