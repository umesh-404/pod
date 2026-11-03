// The Pod window on its Notch page in a plain browser, for looking at the
// live preview and the two sides' lists without the app: Tauri is stood in
// for (settings kept in memory), and the strings waiting in
// src/i18n/pending/ are added so a language can be checked before they are
// merged. Not shipped in the app.
//
//   npx vite --port 1421 --strictPort
//   http://localhost:1421/dev/notch-settings.html?lang=de
//   (?page=general|notch|features|shortcuts, &left=reminder,media&right=job)

import MAC from "../src/i18n/strings.json";

type Table = Record<string, Record<string, unknown>>;
const pending = import.meta.glob<{ strings: Table }>("../src/i18n/pending/*.json", { eager: true, import: "default" });
for (const file of Object.values(pending)) Object.assign((MAC as { strings: Table }).strings, file.strings);

const query = new URLSearchParams(location.search);
const list = (key: string) => (query.has(key) ? query.get(key)!.split(",").filter(Boolean) : undefined);
let settings: Record<string, unknown> = {
  language: query.get("lang") ?? "en",
  ...(list("left") ? { leftWidgets: list("left") } : {}),
  ...(list("right") ? { rightWidgets: list("right") } : {}),
};
type Handler = (e: { event: string; id: number; payload: unknown }) => void;
/** Every page listens to some events more than once (hub-visible: the shell, main, the preview). */
const listeners = new Map<string, Handler[]>();
const emit = (event: string, payload: unknown) => {
  for (const handler of listeners.get(event) ?? []) handler({ event, id: 0, payload });
};

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  transformCallback: (callback: unknown) => callback,
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "plugin:event|listen":
        listeners.set(args.event as string, [...(listeners.get(args.event as string) ?? []), args.handler as Handler]);
        return listeners.size;
      case "boot":
        return { settings, version: "dev", screen: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 }, cursorPoll: false };
      case "save_settings":
        settings = args.settings as Record<string, unknown>;
        console.info("[dev] saved", settings);
        // As save_settings does: every window hears about it, this one included.
        setTimeout(() => emit("settings-changed", settings), 0);
        return null;
      case "hub_shown":
        return true;
      default:
        return null;
    }
  },
};

await import("../src/settings/main");
// Once the window is up, on the page asked for.
const page = query.get("page") ?? "notch";
for (let i = 0; i < 50 && !listeners.has("hub-page"); i++) await new Promise((r) => setTimeout(r, 20));
emit("hub-page", page);
(window as unknown as { podDev: unknown }).podDev = { settings: () => settings, emit };
