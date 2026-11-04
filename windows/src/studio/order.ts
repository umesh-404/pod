// The PDF editor's pages, kept apart from the DOM so they can be tested
// (tests/studio.test.mjs): what the editor holds, moving, turning and removing
// pages, the default file name, and which slot the pointer is over.

export type SourceKind = "pdf" | "image";

/** A file in the editor, as pdfstudio.rs describes it. */
export interface StudioSource {
  id: number;
  name: string;
  kind: SourceKind;
  /** Each page's size as it shows before any turn here (points; pictures: pixels). */
  pages: { w: number; h: number }[];
}

export interface StudioFailure {
  name: string;
  error: string;
}

export interface StudioState {
  session: number;
  sources: StudioSource[];
  failed: StudioFailure[];
}

/** One page on the grid. `key` stays the same while it moves. */
export interface StudioPage {
  key: string;
  source: number;
  /** Its page in the source, from 0. */
  page: number;
  /** Quarter turns clockwise added here, 0 to 3. */
  turns: number;
  w: number;
  h: number;
  name: string;
  kind: SourceKind;
}

/** Every page of `sources`, in order. */
export function pagesOf(sources: readonly StudioSource[]): StudioPage[] {
  const out: StudioPage[] = [];
  for (const s of sources) {
    s.pages.forEach((size, page) => {
      out.push({ key: `${s.id}:${page}`, source: s.id, page, turns: 0, w: size.w, h: size.h, name: s.name, kind: s.kind });
    });
  }
  return out;
}

/** `list` with the item at `from` moved to `to` (both clamped). */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item);
  return out;
}

/** `page` turned `by` quarter turns more (negative: anticlockwise). */
export function turn(page: StudioPage, by: number): StudioPage {
  return { ...page, turns: (((page.turns + by) % 4) + 4) % 4 };
}

/** Width over height of the box a page is drawn in. */
export const CELL_RATIO = 3 / 4;

/**
 * How much a page drawn to fit the cell must be scaled once turned, so the
 * turned page fits the cell too (1 when it isn't turned sideways).
 */
export function turnScale(w: number, h: number, turns: number): number {
  if (turns % 2 === 0 || !(w > 0 && h > 0)) return 1;
  const fit = (pw: number, ph: number) => Math.min(CELL_RATIO / pw, 1 / ph);
  return fit(h, w) / fit(w, h);
}

/** The name the new PDF is given at first, without ".pdf". */
export function defaultName(sources: readonly StudioSource[]): string {
  const first = sources.find((s) => s.kind === "pdf") ?? sources[0];
  if (!first) return "PDF";
  const stem = first.name.replace(/\.[^.]+$/, "") || "PDF";
  return first.kind === "pdf" ? `${stem} (edited)` : `${stem} (pages)`;
}

export interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The slot under (`x`, `y`), else the nearest one; -1 when there are none. */
export function slotAt(slots: readonly Slot[], x: number, y: number): number {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) return i;
    const dx = x - (s.x + s.w / 2);
    const dy = y - (s.y + s.h / 2);
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/** How many slots fit on one row (they share a top edge with the first). */
export function columns(slots: readonly Slot[]): number {
  if (slots.length === 0) return 1;
  const top = slots[0].y;
  let n = 0;
  while (n < slots.length && Math.abs(slots[n].y - top) < 2) n++;
  return Math.max(1, n);
}

/** What the backend saves: each page's source, page and turns. */
export function saveOrder(pages: readonly StudioPage[]): { source: number; page: number; turns: number }[] {
  return pages.map((p) => ({ source: p.source, page: p.page, turns: p.turns }));
}

/** The pages of sources not seen before, to add at the end. */
export function newPages(state: StudioState, seen: ReadonlySet<number>): StudioPage[] {
  return pagesOf(state.sources.filter((s) => !seen.has(s.id)));
}
