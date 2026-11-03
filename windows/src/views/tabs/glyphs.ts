// Glyphs only the tabs use, on the same 24×24 grid as views/icons.ts.
// Stroked ones are drawn with svg(path, size, { stroke: 1.8 }).

export const GLYPHS = {
  // photo (stroked)
  photo: "M4.5 5.5h15v13h-15zM4.5 15.5l4.2-4.2 3.6 3.6 2.6-2.6 4.6 4.6M15.5 9.2a.9.9 0 1 0 0 .1",
  // film (stroked)
  film: "M4.5 5.5h15v13h-15zM8 5.5v13M16 5.5v13M4.5 9.5H8M4.5 14.5H8M16 9.5h3.5M16 14.5h3.5",
  // trash (stroked)
  trash: "M5 7h14M10 7V4.8h4V7M7 7l.9 12.2h8.2L17 7M10.3 10.5v5.5M13.7 10.5v5.5",
  // bell (stroked)
  bell: "M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5zM10 20.5h4",
  // flag (stroked): deadlines
  flag: "M6 21V4.5M6 5h10.5l-2 3.5 2 3.5H6",
  // camera.viewfinder (stroked)
  viewfinder: "M4 8.5V5.5A1.5 1.5 0 0 1 5.5 4h3M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3M20 15.5v3a1.5 1.5 0 0 1-1.5 1.5h-3M8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z",
  // doc.on.clipboard (stroked)
  clipboard: "M8.5 5H6.5A1.5 1.5 0 0 0 5 6.5v12A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-12A1.5 1.5 0 0 0 17.5 5h-2M9 3.5h6v3H9zM8.5 11h7M8.5 14.5h5",
  // server.rack (stroked)
  server: "M4.5 4.5h15v6h-15zM4.5 13.5h15v6h-15zM7.5 7.5h.01M7.5 16.5h.01",
  // square.and.pencil (stroked)
  compose: "M11 4.5H6A1.5 1.5 0 0 0 4.5 6v12A1.5 1.5 0 0 0 6 19.5h12a1.5 1.5 0 0 0 1.5-1.5v-5M17.5 3.5l3 3-8 8H9.5v-3z",
  // arrow.clockwise (stroked)
  refresh: "M19 12a7 7 0 1 1-2.05-4.95M19 4.5V8h-3.5",
  // forward.end (stroked): skip
  skip: "M6 6l8 6-8 6zM17.5 6v12",
  // stop (filled)
  stop: "M7 7h10v10H7z",
} as const;
