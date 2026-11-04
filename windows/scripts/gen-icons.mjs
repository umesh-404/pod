// Renders Pod's icons from the hand-written SVGs in src-tauri/icons/source/
// (Stew, the app icon, and the simpler tray drawing) with Microsoft Edge headless
// (Skia, the same rasteriser as WebView2) and writes the files the app uses, in
// src-tauri/icons/:
//   32x32.png, 128x128.png, 128x128@2x.png, icon.png, icon.ico
//   tray/tray-<size>.png and tray/tray-<size>-update.png (tray.rs)
// Small sizes come from the hand-tuned small drawings, not from the master.
//
//   npm run icons            (node scripts/gen-icons.mjs [out dir])
//
// Set EDGE to the msedge.exe path if it is not in the usual place.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const icons = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");
const here = join(icons, "source");
const out = resolve(process.argv[2] ?? icons);
const edge = process.env.EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

// The tray's blue copy while an update waits: Stew takes Pod's update blue
// (#3B82F6), keeping its shading and rim.
const BLUE = {
  "#B5E79A": "#BFDBFE", "#8FD078": "#6EA8FA", "#7CC46A": "#3B82F6",
  "#3F8A3A": "#1D4ED8", "#2F5F2A": "#1E3A8A",
};

const svg = (name, blue = false) => {
  let text = readFileSync(join(here, name), "utf8");
  if (blue) for (const [g, b] of Object.entries(BLUE)) text = text.replaceAll(g, b);
  return text;
};

/** Each file: [output path, source svg, size, blue]. */
const jobs = [
  ["32x32.png", "icon-32.svg", 32],
  ["128x128.png", "icon.svg", 128],
  ["128x128@2x.png", "icon.svg", 256],
  ["icon.png", "icon.svg", 512],
  ["ico/16.png", "icon-16.svg", 16],
  ["ico/20.png", "icon-20.svg", 20],
  ["ico/24.png", "icon-24.svg", 24],
  ["ico/32.png", "icon-32.svg", 32],
  ["ico/40.png", "icon-32.svg", 40],
  ["ico/48.png", "icon-32.svg", 48],
  ["ico/64.png", "icon.svg", 64],
  ["ico/256.png", "icon.svg", 256],
];
for (const size of [16, 20, 24, 32, 40, 48]) {
  const src = { 16: "tray-16.svg", 20: "tray-20.svg", 24: "tray-24.svg" }[size] ?? "tray.svg";
  jobs.push([`tray/tray-${size}.png`, src, size, false]);
  jobs.push([`tray/tray-${size}-update.png`, src, size, true]);
}

const page = `<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>
const jobs = ${JSON.stringify(jobs.map(([o, s, size, blue]) => [o, svg(s, blue), size]))};
(async () => {
  const res = {};
  for (const [o, text, size] of jobs) {
    const img = new Image();
    img.src = "data:image/svg+xml;base64," + btoa(text.replace(/width="\\d+" height="\\d+"/, 'width="' + size + '" height="' + size + '"'));
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = size;
    c.getContext("2d").drawImage(img, 0, 0, size, size);
    res[o] = c.toDataURL("image/png").split(",")[1];
  }
  document.getElementById("out").textContent = JSON.stringify(res);
})();
</script>`;

const tmp = mkdtempSync(join(tmpdir(), "pod-icons-"));
try {
  const html = join(tmp, "render.html");
  writeFileSync(html, page);
  const dom = execFileSync(edge, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
    `--user-data-dir=${join(tmp, "profile")}`, "--virtual-time-budget=10000",
    "--dump-dom", pathToFileURL(html).href,
  ], { encoding: "utf8", maxBuffer: 64 << 20 });
  const json = dom.match(/<pre id="out">([^<]*)<\/pre>/)?.[1];
  if (!json) throw new Error("Edge rendered nothing");
  const png = Object.fromEntries(Object.entries(JSON.parse(json)).map(([k, v]) => [k, Buffer.from(v, "base64")]));

  for (const [o, data] of Object.entries(png)) {
    if (o.startsWith("ico/")) continue;
    mkdirSync(dirname(join(out, o)), { recursive: true });
    writeFileSync(join(out, o), data);
  }

  // icon.ico: every size as a PNG entry, smallest first.
  const sizes = Object.keys(png).filter((k) => k.startsWith("ico/")).map((k) => +k.slice(4, -4)).sort((a, b) => a - b);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const data = png[`ico/${s}.png`];
    const e = 6 + 16 * i;
    header[e] = s >= 256 ? 0 : s;
    header[e + 1] = s >= 256 ? 0 : s;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  writeFileSync(join(out, "icon.ico"), Buffer.concat([header, ...sizes.map((s) => png[`ico/${s}.png`])]));
  if (process.argv[3] === "--keep-ico-pngs") {
    for (const s of sizes) {
      mkdirSync(join(out, "ico"), { recursive: true });
      writeFileSync(join(out, `ico/${s}.png`), png[`ico/${s}.png`]);
    }
  }
  console.log(`wrote ${Object.keys(png).length - sizes.length} PNGs and icon.ico (${sizes.join(", ")}) to ${out}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
