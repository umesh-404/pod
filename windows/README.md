# Pod for Windows and Linux

Pod puts a small island at the top of your screen, with Mochi in the middle.
The island is a temporary workspace: drag files over it and drop them on an
action, keep files on a shelf, set reminders, and glance at what is going on
without leaving what you are doing. No API keys, no accounts, nothing sent
anywhere you didn't set up.

This folder is the whole app: a [Tauri 2](https://tauri.app) app with a Rust
backend (`src-tauri/`) and a TypeScript front end with no framework (`src/`).
It is built and tested on Windows 10/11; Linux support is partial (see
[Linux](#linux)).

There are no releases yet: Pod still carries Coucou's character, icon and
sounds, which may not be redistributed (see [LICENSE-ASSETS.md](../LICENSE-ASSETS.md)).
[Build it from source](#build-run-test).

## Features

| Where | What |
|---|---|
| **Drop actions** | Drag files over the island and tiles appear: **Convert File Format** (video, audio, images, with ffmpeg), **Zip / Unzip**, **Resize image**, **PDF tools** (merge, split, rotate, compress, photos → PDF), **Text from image** (Windows OCR), **Remove EXIF**, **Video to GIF**, **Compress video**, **SHA-256 checksum**, **Batch rename**, **Copy to workspace**. What an action makes is saved in the workspace folder |
| **Shelf** tab | The files in your workspace folder, with thumbnails. Drag one out to drop a copy anywhere; remove one to send it to the Recycle Bin / Trash |
| **Reminders** tab | Type "call Sam at 4pm" or "essay in 2 days": reminders and deadlines, with a sound when one is due |
| **Notes** tab | Plain-text notes, saved as `.md` files on the shelf |
| **Tools** tab | Screenshot to shelf, focus timer, smart clipboard (JSON, JWT, Base64, Unix time…), the dev servers running on this computer |
| Left of the compact notch | The reminder that is due, else the nearest deadline as a countdown |
| Right of the compact notch | Live items taking turns: file jobs, focus timer, next meeting (from `.ics` / webcal links you paste), now playing, shelf count, system glance (CPU, memory, battery), camera and microphone in use, new downloads, dev servers |

Every drop action, tab, tool and live item can be switched off in the Pod
window (tray → Settings…); what is off disappears from the island.

## How it works

### The island

There is no notch on a PC, so the island is a black shape drawn at the top
centre of the chosen display, in a borderless, transparent, always-on-top
window that never takes focus. Clicks outside the shape go through to what is
underneath. Hidden, the island shrinks to an invisible strip along the top
edge; moving the pointer there wakes it. The compact island sits under a top
taskbar when there is one.

### The drop pipeline

1. **Drag over.** While files are dragged over the island, it opens on the drop
   tiles (`src/island/file-actions.ts`, `src/views/files.ts`).
2. **Drop.** The OS delivers the real paths: on Windows WebView2 takes the drop
   itself and hands back its `File` objects (`webview_drop.rs`), because drags
   from the classic Explorer views never reached Tauri's own drop target; on
   Linux it is Tauri's drag-drop window event.
3. **Record.** Rust records those paths as *dropped* (`files.rs`). Each is good
   once, for a couple of minutes.
4. **Act.** Every file command (convert, zip, resize, PDF, move to workspace)
   starts with `files::take_dropped`: only paths a real drop just delivered are
   accepted. A script injected into the page could otherwise ask Rust to copy,
   move or zip any file the user can read; this way it can't.

The same rules hold everywhere a file is written: outputs go to the
workspace folder, the original is never touched (except by **Batch rename**,
which renames it in place, with Undo), nothing is ever
overwritten (a taken name gets " (2)", " (3)"…), and a half-written output is
removed.

- **Zip / Unzip** (`archive.rs`) streams everything, checks an archive whole
  before writing (zip-slip paths, symbolic links, more than 20 GB unpacked or an
  impossible compression ratio are refused).
- **Resize image** (`resize.rs`) is pure Rust (`image` crate): an upright copy
  in the same format, never larger than the original.
- **PDF tools** (`pdf.rs`) are pure Rust (`lopdf`); password-protected PDFs are
  left alone.

### The workspace

**Copy to workspace** copies dropped files into one folder, `~/Notch Workspace`
by default, changed in Settings (`workspace.rs`); the originals stay where they
were. The shelf shows that folder and watches it with `notify` (no polling).
Changing the folder moves what is in the old one to the new one, after asking:
across drives a move is a copy, and the original is removed only once the whole
copy succeeded. The home folder, a drive root and the usual system folders are
never moved, emptied or removed.

A name coming from the page (shelf, notes) must be a single file name directly
in the workspace, never a path, so the page can't reach anything else. A drag
out of the shelf offers a copy only.

### ffmpeg

Converting needs ffmpeg (`convert.rs`): the one picked in Settings, else one Pod
downloaded, else the one on `PATH`. On Windows, when there is none, the card
offers **Download ffmpeg**: the "essentials" build from
[gyan.dev](https://www.gyan.dev/ffmpeg/builds/) (about 115 MB, once). Its
published `.sha256` is fetched first, the archive is hashed while it downloads,
and it is unpacked only when the SHA-256 matches. On Linux, install ffmpeg with
your package manager. ffmpeg runs at a lower priority, and the result is saved
in the workspace folder.

### Efficiency

Pod aims at 0 % CPU when the island is hidden.

- The cursor poll that drives click-through runs only while the island is shown,
  and is parked (not just slowed) when it is hidden. The webview is asked to keep
  its memory low while hidden or compact.
- The compact notch has one timer, set for the next moment some text on it
  changes; widths are measured once per change of text, never per frame.
- The watchers behind live items (now playing, system glance, camera and
  microphone, downloads, dev servers) run only for the items switched on and
  only while the island is not hidden. Most of them sleep on OS events (system
  media controls, MPRIS, registry change notifications, file system events)
  rather than polling; the system glance samples every 2 s and dev servers
  every 5 s, only while shown.
- Reminders have one thread that sleeps until the next due time (60 s at most,
  to catch clock changes and resume from sleep). The calendar task sleeps until
  the next refresh (15 min) or meeting boundary, and stops when there are no
  links.

### Privacy

No telemetry. The network is used only for: the calendar links you paste
(fetched from this computer, 5 MB at most), the ffmpeg download you click, and
the update check once you allow it. Preferences, reminders and notes stay on
the computer.

### Languages

Pod speaks English, 简体中文, हिन्दी, Español, العربية, Français, বাংলা,
Português (Brasil), Русский, Bahasa Indonesia, Deutsch, Türkçe, 한국어 and
日本語. **Settings → General → Language** picks one; **System** follows the
system's language when Pod has it, English otherwise. Everything switches at
once, without a restart. In Arabic the text reads right to left; the island's
layout keeps its sides.

The strings live in `src/i18n/strings.json` (the table inherited from Coucou)
and `src/i18n/extra.json` (Pod's own), both keyed by the English text; a string
missing in a language shows in English. The Rust side (tray, errors) embeds the
same two files. `tests/i18n.test.mjs` checks that every string the code shows
is translated in every language.

### New versions

Pod can tell you when a new version is out. Nothing goes to GitHub before you
agree: the island asks once, and **Settings → General → Updates** has the same
switch. Once allowed, Pod makes one unauthenticated request to
`api.github.com/repos/umesh-404/pod/releases` at launch and every 6 hours.
On Windows, **Update now** downloads the installer this copy came from (from
GitHub hosts only), checks it against the SHA-256 GitHub publishes for it, and
runs it. Elsewhere, Pod opens the release page. After an update, the island
shows once what the new version brings (`src/whats-new/whats-new.json`).

## Build, run, test

You need [Rust](https://rustup.rs) and [Node 20+](https://nodejs.org). On
Windows, also the **MSVC build tools** (Visual Studio Build Tools, "Desktop
development with C++"); WebView2 ships with Windows 10/11. For Linux, see
[Linux](#linux).

```powershell
cd windows
npm install
npm run tauri dev      # live-reloading development build
npm run pack           # release build and installers in windows/release/
```

`npm run dev` alone serves the front end in an ordinary browser, enough to
work on the island's looks. Installing is optional: `target/release/pod.exe`
runs on its own. There is no taskbar window: the island and the tray icon are
the app, and Quit is in the tray menu.

Tests:

```powershell
npm test                                   # front-end tests (node:test)
cargo test                                 # Rust unit tests
python scripts/test-whats-new.py           # the "What's new" entry of this version
```

Data folders: preferences in `%APPDATA%\Pod` (`~/.config/pod` on Linux); the
log, `pod.log`, and the drop inbox in `%LOCALAPPDATA%\Pod`
(`~/.local/share/pod`). The log stays on your machine.

## Windows and Linux

| | Windows | Linux |
|---|---|---|
| Island window | Win32, click-through from a cursor poll | gtk-layer-shell overlay where the compositor supports it (KDE Plasma, COSMIC, Hyprland, Sway…); on GNOME, an XWayland dock window |
| Dropping files | WebView2's own drop | Tauri's drag-drop event |
| ffmpeg | Downloaded on request (checksum-verified), or your own | Your package manager's, on `PATH` |
| Shelf thumbnails | The shell's thumbnails | Pictures directly, else the freedesktop thumbnail cache |
| Now playing | System media controls | MPRIS |
| Camera and microphone in use | From Windows' capability access records | Not available (nothing shown) |
| Screenshot to shelf | The Snipping Tool overlay | The XDG screenshot portal, else `gnome-screenshot` or `spectacle` |
| Global shortcuts | Hot keys (defaults chosen to avoid AltGr characters) | X11 key grabs; on Wayland the GlobalShortcuts portal, else commands to bind by hand |
| Update now | Runs the checked installer | Opens the release page |

## Linux

Linux support is partial: the island, drop actions, shelf, tabs and most live
items work, but less is tested than on Windows and some items have no Linux
source (camera and microphone in use).

```bash
sudo apt install build-essential pkg-config \
  libwebkit2gtk-4.1-dev libgtk-layer-shell-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev libdbus-1-dev patchelf
cd windows
npm install
npm run tauri dev      # live-reloading development build
npm run pack           # AppImage, .deb and .rpm in windows/release/
```

An Arch package recipe is in `linux/arch/` (`makepkg -si`).

- **The island** is a gtk-layer-shell overlay anchored to the top edge on
  compositors that support it. GNOME has no layer-shell, so there Pod runs
  through XWayland as a dock window: top centre, on every workspace.
  `POD_X11=0` keeps the native Wayland window, `POD_DOCK=0` makes it a utility
  window instead of a dock, `POD_LAYER_SHELL=0` forces the regular window.
- **Click-through** is the window's input region, kept equal to the island's
  shape.
- **Mochi's eyes** follow the pointer only while it is over the island: Wayland
  gives no app the cursor position anywhere else.
- **Global shortcuts** are X11 key grabs in an X11 session. On Wayland, Pod
  hands them to the desktop through the XDG GlobalShortcuts portal (KDE Plasma 6,
  GNOME 48+, Hyprland, COSMIC…); the desktop may ask you to confirm them. Without
  the portal, **Settings → Shortcuts** lists `pod --shortcut <id>` commands to
  bind in your desktop's keyboard settings.
- **Languages**: Hindi, Bengali, Chinese, Japanese, Korean and Arabic need fonts
  for those scripts (`fonts-noto-core` and `fonts-noto-cjk` on Debian and
  Ubuntu). **System** follows `LANGUAGE` / `LANG`.

## Project layout

```
windows/
  src/                 front end (TypeScript, no framework)
    core/              state, bridge to Rust, layout, focus timer, smart clipboard
    island/            the island: state machine, drop actions, compact notch, tabs
    views/             island views; views/tabs/ holds Shelf, Reminders, Notes, Tools
    hub/, settings/    the Pod window (settings)
    mochi/             Mochi, drawn in Canvas 2D
    desktop/           Mochi's own window, when he lives on the desktop
    i18n/              strings.json, extra.json and the lookup
    whats-new/         the card shown once after an update
  src-tauri/src/       Rust backend
    island.rs          window, geometry, click-through, cursor poll
    files.rs           drop inbox and the record of dropped paths
    webview_drop.rs    WebView2 drops (Windows)
    convert.rs archive.rs resize.rs pdf.rs workspace.rs   drop actions
    shelf.rs quicknote.rs reminders.rs capture.rs clipboard.rs
    calendar.rs media.rs sysglance.rs privacy.rs downloads.rs devservers.rs
    platform/          everything that differs between Windows and Linux
  tests/               front-end tests
  scripts/             icon generator, packaging, test-whats-new.py
  sounds/              Mochi's sounds (Coucou assets, see LICENSE-ASSETS.md)
```
