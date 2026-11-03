# Pod — guide for AI coding agents

Pod is a Windows and Linux app (Tauri 2) that turns the top of the screen into a small island, a "notch", with Mochi, an animated character, inside. The notch is a temporary workspace. Drag a file over it and drop it on an action (convert, move to the workspace, zip or unzip, resize, PDF tools…). The shelf keeps files and lets you drag copies back out. Reminders and deadlines sit on the left of the compact notch, and live items take turns on the right. Pod is a fork of Coucou (github.com/Louis-CFM/coucou).

## Where things are
- `windows/src-tauri/src/` — Rust: the island window, settings, file drop (`webview_drop.rs`, `files.rs`), workspace, convert (ffmpeg), archive, shelf, reminders, and the right-side widgets (media, sysglance, privacy, calendar, downloads).
- `windows/src/` — TypeScript, no framework:
  - `island/` — the island and its state machine;
  - `views/` — what the island shows;
  - `settings/` — the Settings window;
  - `mochi/` — the character, drawn in code;
  - `i18n/` — `strings.json` + `extra.json`, 14 languages.
- `windows/sounds/` — the WAV sounds (Coucou's, to be replaced before any release; see LICENSE-ASSETS.md).
- `windows/README.md` — how the app works in detail.

## Build
```
cd windows && npm install && npm run tauri dev
```
Checks:
- `cd windows && npx tsc --noEmit && npm test`
- `cargo test --workspace`
- `python scripts/test-whats-new.py`

## Rules
- **No API keys, no accounts, no LLM features.** Pod works locally. Internet use is limited to what the user set up: .ics calendar links, update checks from github.com/umesh-404/pod, and the one-time ffmpeg download (checksum verified).
- No telemetry.
- Secrets, if any are ever needed, live in the OS keychain, never on disk or in git.
- Keep the bundle identifier `io.github.umesh404.pod`.
- Keep the island's existing look. New views follow its style.
- Efficiency budgets:
  - 0 % CPU while the island is hidden, under 0.5 % of a core when idle.
  - Use events instead of polling, and sample only what is on screen.
  - Coalesce timers.
  - Animate only `transform` and `opacity`, and run rAF only while animating.
  - Heavy jobs (ffmpeg) run at low priority (EcoQoS).
- Files the user drops are only accepted through `files::take_dropped` (real drops, each path usable once). Never overwrite a file: use `files::unique_path`.
- Every feature can be switched off in Settings, and a switched-off feature disappears from the notch.
- Every user-facing string goes through `t()` and is translated in all 14 languages (`windows/src/i18n/extra.json`); `tests/i18n.test.mjs` enforces it.
- Every release:
  - adds its CHANGELOG.md section;
  - adds a What's new entry in `windows/src/whats-new/whats-new.json`, with 1 to 4 items in every language (`python windows/scripts/test-whats-new.py` checks it).
- Mochi, the icon and the sounds belong to Coucou's author: no public builds until they are replaced (LICENSE-ASSETS.md).
