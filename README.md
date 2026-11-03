# Pod

**A notch island at the top of your screen, for Windows and Linux.**

Pod puts a small island at the top of your screen, with Mochi in the middle.
It is a temporary workspace: drag files over it and drop them on an action
(convert, zip, resize, PDF tools, move to your workspace folder), keep files on
a shelf and drag copies back out, set reminders and deadlines that count down
on the left of the notch, and see live items take turns on the right. Everything
runs locally: no API keys, no accounts, and 0 % CPU while the island is hidden.

Version 0.1.0 · Windows 10/11 · Linux (partial) · [Tauri 2](https://tauri.app) + Rust

## Features

- **Drop actions.** Drag files over the island and tiles appear:
  - **Convert File Format**: video, audio and images, with ffmpeg.
  - **Zip / Unzip**.
  - **Resize image**.
  - **PDF tools**: merge, split, rotate, compress, photos → PDF.
  - **Move to workspace**.

  Originals are never overwritten, and only files you actually dropped can be
  touched.
- **Shelf.** The files in your workspace folder, with thumbnails. Drag one out
  to drop a copy wherever you are working.
- **Reminders and deadlines.** Type "call Sam at 4pm" or "essay in 3 days". The
  due reminder or the nearest deadline shows on the left of the compact notch.
- **Live items on the right of the notch**, taking turns:
  - now playing;
  - system glance (CPU, memory, battery);
  - camera and microphone in use (Windows);
  - the next meeting, from `.ics` / webcal links you paste;
  - new downloads;
  - dev servers running on this computer;
  - the focus timer.
- **Tabs**: Shelf, Reminders, Notes (plain-text notes), Tools (screenshot to
  shelf, focus timer, smart clipboard, dev servers).
- **Everything can be switched off in Settings.** What is off disappears from
  the island.
- **Local-first.** No telemetry, no accounts, no keys. The network is used only
  for the calendar links you add, the ffmpeg download you ask for (checked
  against its published SHA-256), and the update check once you allow it.
- **14 languages**, switched without a restart.

Linux support is partial: the island, drop actions, shelf and tabs work, but
some live items have no Linux source yet (camera and microphone in use), ffmpeg
comes from your package manager, and less is tested than on Windows. See
[windows/README.md](windows/README.md#linux).

## Build from source

There are no releases yet. Pod still carries the Mochi character, the icon and
the sounds from Coucou, which may not be redistributed; builds will be published
once they are replaced. See [LICENSE-ASSETS.md](LICENSE-ASSETS.md).

You need [Rust](https://rustup.rs) and [Node 20+](https://nodejs.org) (on
Windows, the MSVC build tools; on Linux, WebKitGTK and gtk-layer-shell, listed
in [windows/README.md](windows/README.md#linux)).

```bash
git clone https://github.com/umesh-404/pod.git
cd pod/windows
npm install
npm run tauri dev      # development build
npm run pack           # release build and installers in windows/release/
npm test               # front-end tests
```

How Pod works (the drop pipeline, the workspace, the ffmpeg download,
efficiency, platform differences, project layout) is in
[windows/README.md](windows/README.md).

## Credits

Pod is a fork of [Coucou](https://github.com/Louis-CFM/coucou) by Louis Raillé,
released under the MIT License. The island, Mochi and much of the app's
foundation come from Coucou.

## License

The source code is under the [MIT License](LICENSE). The Mochi character, the
app and tray icons and the sounds are Coucou's assets and are **not** covered by
it: see [LICENSE-ASSETS.md](LICENSE-ASSETS.md).
