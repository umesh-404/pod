# Changelog

Pod's changes, newest first. Pod is a fork of Coucou (Windows and Linux app), version 0.5.8.

## 0.1.0 — unreleased

- Forked from Coucou and renamed to Pod (identifier `io.github.umesh404.pod`).
- Removed the Claude Code and agent features, chat, API keys, the phone link, WhatsApp, Mail, GitHub, Spotify, Flow and voice. The Mac, iPhone and Android apps and the relay are gone; Pod is the Windows and Linux app.
- The notch is a temporary workspace: drag a file over it and drop it on an action.
  - Convert its format with ffmpeg, which Pod finds or downloads once.
  - Move it to the workspace folder, which you can change in Settings; Pod moves the files already there.
  - Zip or unzip it.
  - Resize it.
- The shelf lists what is in the workspace, with thumbnails. It shows six files in one row and scrolls sideways for more. Drag a file out to copy it where you work.
- PDF editor: drop pictures and PDFs on its tile and arrange the pages in the Pod window (drag, keyboard, turn, remove with Undo, add more files), then save one PDF to the shelf. Pictures dragged out of a web page work too.
- Self-repair: Pod checks its shelf folder, settings, downloaded ffmpeg and leftovers at launch and every 6 hours while you are away, fixes what is its own, and shows the result in Settings → General → Health. A broken WebView2 runtime is reported before the first window, with Windows' own repair offered.
- A Pod window whose page crashes (Edge's "This page is having a problem") reloads itself instead of staying blank.
- Reminders and deadline countdowns sit on the left of the notch. Live items take turns on the right, and you choose which ones in Settings.
- Stew, Pod's own character, lives in the notch: a glossy green ball drawn in code, with his own expressions, launch greeting and wardrobe (beanie, round glasses, sunglasses, scarf, headphones, crown, flower, party hat). Outfits saved by an earlier build that Pod no longer has are taken off.
- The interface is set in Nilo, Pod's own typeface (SIL Open Font License), in place of PP Mori. Its six styles ship with the app.
