// SVG paths standing in for the SF Symbols used by the macOS island.
// Drawn on a 24×24 grid so they read at the same optical size.

export const ICONS = {
  // house.fill
  house: "M12 3.2 2.8 10.6V21h6.6v-5.4h5.2V21h6.6V10.6L12 3.2z",
  // bubble.left.fill
  bubble: "M12 3.6c-5 0-9 3.3-9 7.4 0 2.3 1.3 4.4 3.3 5.7-.2 1.2-.8 2.4-1.7 3.4 1.9-.2 3.6-.9 4.9-1.9 .8.2 1.6.3 2.5.3 5 0 9-3.3 9-7.5s-4-7.4-9-7.4z",
  // plus
  plus: "M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4z",
  // gearshape
  gear: "M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8zm0 1.8a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2zM10.9 2h2.2l.35 2.1c.6.17 1.16.4 1.67.71l1.9-1 1.55 1.55-1 1.9c.3.5.54 1.07.7 1.67l2.13.35v2.2l-2.12.35c-.17.6-.4 1.16-.71 1.67l1 1.9-1.55 1.55-1.9-1c-.5.3-1.07.54-1.67.7L13.1 22h-2.2l-.35-2.12c-.6-.17-1.16-.4-1.67-.71l-1.9 1L5.43 18.6l1-1.9c-.3-.5-.54-1.07-.7-1.67L3.6 14.7v-2.2l2.12-.35c.17-.6.4-1.16.71-1.67l-1-1.9 1.55-1.55 1.9 1c.5-.3 1.07-.54 1.67-.7L10.9 2z",
  /** Microphone / camera in use (Lucide "mic", "video", ISC), drawn with a stroke. */
  mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3",
  camera: "M16 13l5.22 3.48a.5.5 0 0 0 .78-.42V7.87a.5.5 0 0 0-.75-.43L16 10.5M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
  /** Settings: an outlined cog (Lucide "settings", ISC), drawn with a stroke. */
  settings: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  gearFill: "M10.9 2h2.2l.35 2.1c.6.17 1.16.4 1.67.71l1.9-1 1.55 1.55-1 1.9c.3.5.54 1.07.7 1.67l2.13.35v2.2l-2.12.35c-.17.6-.4 1.16-.71 1.67l1 1.9-1.55 1.55-1.9-1c-.5.3-1.07.54-1.67.7L13.1 22h-2.2l-.35-2.12c-.6-.17-1.16-.4-1.67-.71l-1.9 1L5.43 18.6l1-1.9c-.3-.5-.54-1.07-.7-1.67L3.6 14.7v-2.2l2.12-.35c.17-.6.4-1.16.71-1.67l-1-1.9 1.55-1.55 1.9 1c.5-.3 1.07-.54 1.67-.7L10.9 2zM12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z",
  // speaker.wave.2
  speakerOn: "M11 4.5 6.5 8.2H3.4v7.6h3.1L11 19.5v-15zm3.2 3a5.3 5.3 0 0 1 0 9 .9.9 0 0 0 .9 1.55 7.1 7.1 0 0 0 0-12.1.9.9 0 0 0-.9 1.55zm2.6-3.1a8.9 8.9 0 0 1 0 15.2.9.9 0 0 0 .92 1.55 10.7 10.7 0 0 0 0-18.3.9.9 0 0 0-.92 1.55z",
  // speaker.slash
  speakerOff: "M11 4.5 6.5 8.2H3.4v7.6h3.1L11 19.5v-15zm3.6 4.1 1.27-1.27 2.33 2.33 2.33-2.33 1.27 1.27L19.47 11l2.33 2.33-1.27 1.27-2.33-2.33-2.33 2.33-1.27-1.27L16.93 11 14.6 8.6z",
  // arrow.up.right
  arrowUpRight: "M8.5 7h8.5v8.5h-2V10.4l-7.1 7.1-1.4-1.4 7.1-7.1H8.5V7z",
  // arrow.clockwise (stroke)
  arrowClockwise: "M19 12a7 7 0 1 1-2.05-4.95M19 4.5V8h-3.5",
  // chevron.right
  chevronRight: "M9 5.5 15.5 12 9 18.5",
  chevronLeft: "M15 5.5 8.5 12 15 18.5",
  // chevron.up
  chevronUp: "M5.5 15 12 8.5 18.5 15",
  // checkmark
  check: "M5 12.5 9.5 17 19 7.5",
  // arrow.up (send)
  arrowUp: "M12 4.5 5.5 11l1.5 1.5 4-4V19.5h2V8.5l4 4L18.5 11 12 4.5z",
  // exclamationmark
  bang: "M11 4h2v10h-2V4zm0 12.2h2v2.2h-2v-2.2z",
  // xmark
  // magnifyingglass (fill)
  magnifier: "M10.5 3a7.5 7.5 0 0 1 5.96 12.06l4.24 4.24-1.4 1.4-4.24-4.24A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z",
  xmark: "M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4 6.4 5z",
  // timer
  timer: "M12 4.2a7.8 7.8 0 1 0 0 15.6 7.8 7.8 0 0 0 0-15.6zm0 1.9a5.9 5.9 0 1 1 0 11.8 5.9 5.9 0 0 1 0-11.8zm-.95 2.3v4.2l3.3 2 .95-1.55-2.4-1.45V8.4h-1.85zM9.2 2h5.6v1.7H9.2V2z",
  // ellipsis
  ellipsis: "M6 10.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2zm6 0a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2zm6 0a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z",
  // star.fill
  star: "M12 3.2l2.6 5.55 5.9.82-4.3 4.3 1.05 6.13L12 17.1l-5.25 2.9L7.8 13.87 3.5 9.57l5.9-.82L12 3.2z",
  // square.stack.fill
  stack: "M5 8h14v11.5H5V8zm1.8-3h10.4v1.6H6.8V5zm1.6-2.6h7.2V4H8.4V2.4z",
  // doc.on.doc (copy)
  copy: "M9 3.5h8.5L21 7v10.5H9v-14zm1.8 1.8v10.4h8.4V7.8l-2.5-2.5h-5.9zM3 7.5h4.2v1.8H4.8v10.4h8.4v-2.2H15v4H3v-14z",
  // chevron.up.chevron.down
  chevronUpDown: "M8 9.5 12 5.5l4 4M8 14.5l4 4 4-4",
  // arrow.triangle.pull (stroked)
  pull: "M6 3a2.2 2.2 0 1 1 0 4.4A2.2 2.2 0 0 1 6 3zM6 7.4v9.2M6 16.6a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4zM18 16.6a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4zM18 16.6V9a3 3 0 0 0-3-3h-4.5M13 3.5 10.5 6 13 8.5",
  // eye (stroked)
  eye: "M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  // checkmark.seal.fill (even-odd)
  seal: "M12 1.8 14.23 3.69 17.1 3.17 18.08 5.92 20.83 6.9 20.31 9.77 22.2 12 20.31 14.23 20.83 17.1 18.08 18.08 17.1 20.83 14.23 20.31 12 22.2 9.77 20.31 6.9 20.83 5.92 18.08 3.17 17.1 3.69 14.23 1.8 12 3.69 9.77 3.17 6.9 5.92 5.92 6.9 3.17 9.77 3.69zM7.4 12.3 8.8 10.9 10.7 12.8 15.2 8.3 16.6 9.7 10.7 15.6z",
  // xmark.octagon.fill (even-odd)
  octagonX: "M21.61 15.98 15.98 21.61 8.02 21.61 2.39 15.98 2.39 8.02 8.02 2.39 15.98 2.39 21.61 8.02zM8.53 7.66 12 11.13 15.47 7.66 16.34 8.53 12.87 12 16.34 15.47 15.47 16.34 12 12.87 8.53 16.34 7.66 15.47 11.13 12 7.66 8.53z",
  // doc.text
  doc: "M6.5 2.6h7l4 4v14.8h-11V2.6zm6.6 1.6v3.3h3.3l-3.3-3.3zM8.6 11h6.8v1.5H8.6V11zm0 3.4h6.8v1.5H8.6v-1.5z",
  // ── Drop targets (views/files.ts) ──
  // arrow.left.arrow.right (stroked): Convert File Format
  convert: "M4.5 8h14M15 4.5 18.5 8 15 11.5M19.5 16h-14M9 12.5 5.5 16 9 19.5",
  // folder.fill: Move to workspace
  folder: "M2.8 6.6A2.3 2.3 0 0 1 5.1 4.3h4.1l2.1 2.2h7.6a2.3 2.3 0 0 1 2.3 2.3v8.9a2.3 2.3 0 0 1-2.3 2.3H5.1a2.3 2.3 0 0 1-2.3-2.3V6.6z",
  // archivebox.fill (even-odd): Zip / Unzip
  archive: "M3 4.2h18v4.3H3V4.2zm1.3 5.6h15.4v9.9H4.3V9.8zm5.2 2.3v1.7h5v-1.7h-5z",
  // arrow.up.left.and.arrow.down.right (stroked): Resize image
  resize: "M14 4h6v6M20 4l-6.5 6.5M10 20H4v-6M4 20l6.5-6.5",
  // ── Now playing (the Spotify pill and card) ──
  // play.fill
  play: "M7 4.6c0-.8.9-1.3 1.6-.9l11 6.9c.6.4.6 1.4 0 1.8l-11 6.9c-.7.4-1.6-.1-1.6-.9V4.6z",
  // pause.fill
  pause: "M6 4.5h4v15H6zM14 4.5h4v15h-4z",
  // forward.fill
  forward: "M2.5 6.2c0-.7.8-1.1 1.4-.7l7.6 5.8c.5.4.5 1 0 1.4l-7.6 5.8c-.6.4-1.4 0-1.4-.7V6.2zm10 0c0-.7.8-1.1 1.4-.7l7.6 5.8c.5.4.5 1 0 1.4l-7.6 5.8c-.6.4-1.4 0-1.4-.7V6.2z",
  // backward.fill
  backward: "M21.5 6.2c0-.7-.8-1.1-1.4-.7l-7.6 5.8c-.5.4-.5 1 0 1.4l7.6 5.8c.6.4 1.4 0 1.4-.7V6.2zm-10 0c0-.7-.8-1.1-1.4-.7l-7.6 5.8c-.5.4-.5 1 0 1.4l7.6 5.8c.6.4 1.4 0 1.4-.7V6.2z",
  // shuffle (stroked)
  shuffle: "M3 7h3.2c1.9 0 3.1.9 4.1 2.5l3.4 5c1 1.6 2.2 2.5 4.1 2.5H21M3 17h3.2c1.6 0 2.7-.6 3.6-1.8M14.2 8.8C15.1 7.6 16.2 7 17.8 7H21M18.6 4.6 21 7l-2.4 2.4M18.6 14.6 21 17l-2.4 2.4",
  // repeat (stroked)
  repeat: "M4 11.5V10a3 3 0 0 1 3-3h13.5M17.6 4.1 20.5 7l-2.9 2.9M20 12.5V14a3 3 0 0 1-3 3H3.5M6.4 19.9 3.5 17l2.9-2.9",
  // music.note
  musicNote: "M12.2 3.6h1.7c.3 2.3 1.8 3.5 4.2 4.6l-.6 1.6c-1.4-.5-2.7-1.2-3.6-2.1v9.5a3.3 3.3 0 1 1-1.7-2.88V3.6z",
  // speaker.slash.fill / speaker.wave.1-3.fill (stroked, the body outlined round)
  volume0: "M3.5 9.5h3L11 5.8v12.4l-4.5-3.7h-3zM15 9.5l5 5M20 9.5l-5 5",
  volume1: "M3.5 9.5h3L11 5.8v12.4l-4.5-3.7h-3zM14.5 9.6a3.4 3.4 0 0 1 0 4.8",
  volume2: "M3.5 9.5h3L11 5.8v12.4l-4.5-3.7h-3zM14.5 9.6a3.4 3.4 0 0 1 0 4.8M17 7.2a6.8 6.8 0 0 1 0 9.6",
  volume3: "M3.5 9.5h3L11 5.8v12.4l-4.5-3.7h-3zM14.5 9.6a3.4 3.4 0 0 1 0 4.8M17 7.2a6.8 6.8 0 0 1 0 9.6M19.4 4.8a10.2 10.2 0 0 1 0 14.4",
  // ── More drop actions (island/file-actions.ts), stroked ──
  // Split PDF: one page cut in two
  split: "M7 3.5h10v6.5H7zM7 14h10v6.5H7zM4 12h2.5M17.5 12H20M9.5 12h5",
  // Compress PDF: arrows pointing in
  compress: "M4.5 4.5 10 10M10 5.5V10H5.5M19.5 19.5 14 14M14 18.5V14h4.5",
  // ── File tools (island/file-actions.ts), stroked ──
  // Text from image: a frame's corners round two lines of text
  textScan: "M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M8 10h8M8 14h5",
  // SHA-256: a hash sign
  hash: "M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h15M4 15h15",
  // Remove EXIF: a location pin, struck through
  pinOff: "M12 21s-6-5.3-6-10.5a6 6 0 0 1 10.4-4.1M17.7 8.6c.2.6.3 1.2.3 1.9C18 15.7 12 21 12 21M12 8.2a2.3 2.3 0 0 1 2.3 2.3M4 4l16 16",
  // Batch rename: a cursor in a text field
  textCursor: "M3.5 7.5h8M3.5 16.5h8M16 4.5v15M13.5 4.5h5M13.5 19.5h5M20.5 7.5v9",
  // Video to GIF: a film strip
  film: "M5 4h14v16H5zM9 4v16M15 4v16M5 8h4M5 12h4M5 16h4M15 8h4M15 12h4M15 16h4",
  // Compress video: a play button with arrows pointing in
  playCompress: "M4 7V4h3M20 7V4h-3M4 17v3h3M20 17v3h-3M10 8.5v7l6-3.5z",
  // ── Tabs (header) and the notch's right side, stroked ──
  // tray: Shelf
  tray: "M3.5 13.5h4.6l1.6 2.6h4.6l1.6-2.6h4.6M3.5 13.5 6.2 5h11.6l2.7 8.5V19h-17z",
  // bell: Reminders
  bell: "M6.2 16.5v-5.3a5.8 5.8 0 0 1 11.6 0v5.3l1.7 1.8h-15zM10.2 20.8h3.6",
  // note.text: Notes
  note: "M6 3.5h8.8l3.2 3.2v13.8H6zM9 10.5h6M9 14h6M9 17.5h3.5",
  // wrench: Tools
  wrench: "M14.8 5.2a4.3 4.3 0 0 0-5.5 5.4l-5.6 5.6a1.9 1.9 0 0 0 2.7 2.7l5.6-5.6a4.3 4.3 0 0 0 5.4-5.5l-2.6 2.6-2.3-.5-.5-2.3z",
  // calendar: next meeting
  calendar: "M4.5 6h15v14h-15zM4.5 10.5h15M8.5 3.5v4M15.5 3.5v4",
  // arrow.down.to.line: a new download
  download: "M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14",
  // terminal prompt: dev servers
  terminal: "M5 7.5 9.5 12 5 16.5M12 17h7",
  // gauge: CPU / RAM
  gauge: "M4.2 16.5a8.2 8.2 0 1 1 15.6 0M12 13.5l3.5-4.5",
} as const;
