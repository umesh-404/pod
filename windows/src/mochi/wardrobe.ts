// Stew's wardrobe — the pure logic. What Stew wears is picked in the wardrobe
// view (right-click on Stew, or the tray menu) and stored in the preferences as
// `mochiOutfit` (the key is kept so old settings files still load). The
// accessories are drawn in ./outfits.ts.

import { N_, labels, t } from "../i18n/i18n";

/** Every accessory, plus "auto" (dress for the season) and "none". Order of the wardrobe. */
export const OUTFIT_SELECTIONS = [
  "auto", "none", "beanie", "roundGlasses", "sunglasses", "scarf", "headphones",
  "crown", "flower", "partyHat",
] as const;

/** What can be stored in the preferences. Keep the raw values stable. */
export type OutfitSelection = (typeof OUTFIT_SELECTIONS)[number];

/** What Stew actually wears: a selection with "auto" resolved. */
export type Outfit = Exclude<OutfitSelection, "auto">;

export const DEFAULT_OUTFIT: OutfitSelection = "auto";

// ── User-visible strings ──────────────────────────────────────────────────────

/** The English names, the keys of their translations (src/i18n). */
export const OUTFIT_KEYS: Record<OutfitSelection, string> = {
  auto: N_("Auto (seasons)"),
  none: N_("None"),
  beanie: N_("Beanie"),
  roundGlasses: N_("Round glasses"),
  sunglasses: N_("Sunglasses"),
  scarf: N_("Scarf"),
  headphones: N_("Headphones"),
  crown: N_("Crown"),
  flower: N_("Flower"),
  partyHat: N_("Party hat"),
};

/** In the current language: every read goes through `t()`. */
export const OUTFIT_LABELS: Record<OutfitSelection, string> = labels(OUTFIT_KEYS);

export const WARDROBE_STRINGS = {
  get title() { return t("Wardrobe"); },
  get autoBadge() { return t("AUTO"); },
  autoNow: (current: string) => t("Auto · {outfit}", { outfit: current }),
  autoHover: (current: string) => t("Auto · follows the seasons (now: {outfit})", { outfit: current }),
};

// ── Logic ─────────────────────────────────────────────────────────────────────

const SELECTION_SET: ReadonlySet<string> = new Set(OUTFIT_SELECTIONS);

/**
 * A stored preference → a selection. A missing or malformed value means
 * "auto"; an id this build doesn't have (one of the outfits Pod inherited and
 * dropped, such as "witchHat", or one from a newer build) means "none", so
 * nobody finds Stew dressed in something they didn't pick.
 */
export function parseOutfit(raw: unknown): OutfitSelection {
  if (typeof raw !== "string" || raw === "") return DEFAULT_OUTFIT;
  return SELECTION_SET.has(raw) ? (raw as OutfitSelection) : "none";
}

/** Easter Sunday of `year` (Meeus/Jones/Butcher), as [month 1–12, day]. */
export function easterDate(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

const DAY_MS = 86_400_000;

/**
 * The seasonal accessory for `date`, read in the user's local calendar.
 * Priority: party hat (new year) > beanie (December) > scarf (autumn) >
 * flower (Easter) > sunglasses (summer) > none.
 */
export function seasonalOutfit(date: Date): Outfit {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();

  // Dec 31 – Jan 2
  if ((month === 12 && day === 31) || (month === 1 && day <= 2)) return "partyHat";
  // Dec 1–26
  if (month === 12 && day <= 26) return "beanie";
  // Oct 1 – Nov 1
  if (month === 10 || (month === 11 && day === 1)) return "scarf";
  // Two days before Easter to the day after. Calendar days counted in UTC so a
  // daylight-saving change in between can't shift the count.
  const [em, ed] = easterDate(year);
  const delta = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, em - 1, ed)) / DAY_MS);
  if (delta >= -2 && delta <= 1) return "flower";
  // Jun 21 – Aug 31
  if ((month === 6 && day >= 21) || month === 7 || month === 8) return "sunglasses";
  return "none";
}

/** "auto" → the season's accessory; anything else is worn as chosen. */
export function resolveOutfit(selection: OutfitSelection, date: Date): Outfit {
  return selection === "auto" ? seasonalOutfit(date) : selection;
}

/**
 * The grey text at the right of the wardrobe header: the hovered accessory,
 * otherwise the current choice.
 */
export function wardrobeHeader(
  hovered: OutfitSelection | null,
  selection: OutfitSelection,
  date: Date,
): string {
  const season = OUTFIT_LABELS[seasonalOutfit(date)];
  if (hovered) return hovered === "auto" ? WARDROBE_STRINGS.autoHover(season) : OUTFIT_LABELS[hovered];
  return selection === "auto" ? WARDROBE_STRINGS.autoNow(season) : OUTFIT_LABELS[selection];
}

/** Same as resolveOutfit, remembered for the day — it is asked every frame. */
export class SeasonCache {
  private key = "";
  private value: Outfit = "none";

  get(selection: OutfitSelection, date = new Date()): Outfit {
    if (selection !== "auto") return selection;
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (key !== this.key) {
      this.key = key;
      this.value = seasonalOutfit(date);
    }
    return this.value;
  }
}
