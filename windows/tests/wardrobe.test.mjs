// Stew's wardrobe: season → accessory, stored preference → accessory (src/mochi/wardrobe.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OUTFIT_SELECTIONS, OUTFIT_LABELS, SeasonCache, easterDate, parseOutfit, resolveOutfit,
  seasonalOutfit, wardrobeHeader,
} from "../src/mochi/wardrobe.ts";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";

/** A local calendar day, at noon so no time zone can push it into the next one. */
const day = (y, m, d) => new Date(y, m - 1, d, 12);
const season = (y, m, d) => seasonalOutfit(day(y, m, d));

test("scarf from October 1 to November 1", () => {
  assert.equal(season(2026, 9, 30), "none");
  assert.equal(season(2026, 10, 1), "scarf");
  assert.equal(season(2026, 10, 31), "scarf");
  assert.equal(season(2026, 11, 1), "scarf");
  assert.equal(season(2026, 11, 2), "none");
});

test("beanie from December 1 to 26", () => {
  assert.equal(season(2026, 11, 30), "none");
  assert.equal(season(2026, 12, 1), "beanie");
  assert.equal(season(2026, 12, 26), "beanie");
  assert.equal(season(2026, 12, 27), "none");
});

test("party hat from December 31 to January 2", () => {
  assert.equal(season(2026, 12, 30), "none");
  assert.equal(season(2026, 12, 31), "partyHat");
  assert.equal(season(2027, 1, 1), "partyHat");
  assert.equal(season(2027, 1, 2), "partyHat");
  assert.equal(season(2027, 1, 3), "none");
});

test("nothing around Valentine's day", () => {
  for (const d of [12, 13, 15, 16]) assert.equal(season(2026, 2, d), "none");
});

test("Easter falls where the calendar says", () => {
  assert.deepEqual(easterDate(2026), [4, 5]);
  assert.deepEqual(easterDate(2027), [3, 28]);
  assert.deepEqual(easterDate(2028), [4, 16]);
  assert.deepEqual(easterDate(2019), [4, 21]);
});

test("a flower from two days before Easter to the day after", () => {
  // Easter 2026 = April 5
  assert.equal(season(2026, 4, 2), "none");
  for (const d of [3, 4, 5, 6]) assert.equal(season(2026, 4, d), "flower", `April ${d}`);
  assert.equal(season(2026, 4, 7), "none");
  // Easter 2027 = March 28
  assert.equal(season(2027, 3, 26), "flower");
  assert.equal(season(2027, 3, 29), "flower");
  assert.equal(season(2027, 3, 30), "none");
  // Easter 2028 = April 16
  assert.equal(season(2028, 4, 14), "flower");
  assert.equal(season(2028, 4, 17), "flower");
  assert.equal(season(2028, 4, 18), "none");
});

test("a daylight-saving change just before Easter doesn't shift the count", () => {
  // Europe moves its clocks on March 29 2026, a week before Easter: midnight
  // and late-evening dates must count the same days as noon.
  assert.equal(seasonalOutfit(new Date(2026, 3, 3, 0, 0)), "flower");
  assert.equal(seasonalOutfit(new Date(2026, 3, 6, 23, 59)), "flower");
  assert.equal(seasonalOutfit(new Date(2026, 3, 7, 0, 0)), "none");
});

test("sunglasses from June 21 to August 31", () => {
  assert.equal(season(2026, 6, 20), "none");
  assert.equal(season(2026, 6, 21), "sunglasses");
  assert.equal(season(2026, 8, 31), "sunglasses");
  assert.equal(season(2026, 9, 1), "none");
});

test("auto dresses for the season, any other choice is worn as is", () => {
  const d = day(2026, 10, 15);
  assert.equal(resolveOutfit("auto", d), "scarf");
  assert.equal(resolveOutfit("none", d), "none");
  assert.equal(resolveOutfit("crown", d), "crown");
});

test("the stored values, in the wardrobe's order", () => {
  assert.deepEqual([...OUTFIT_SELECTIONS], [
    "auto", "none", "beanie", "roundGlasses", "sunglasses", "scarf", "headphones",
    "crown", "flower", "partyHat",
  ]);
  for (const sel of OUTFIT_SELECTIONS) assert.ok(OUTFIT_LABELS[sel], `${sel} has a label`);
});

test("a stored preference is read back as it was saved", () => {
  for (const sel of OUTFIT_SELECTIONS) assert.equal(parseOutfit(sel), sel);
});

test("outfits that are gone, and unknown ids, mean none", () => {
  // Stew's outfits Pod no longer has, and anything else it doesn't know.
  for (const raw of ["witchHat", "santaHat", "bunnyEars", "pumpkin", "bow", "topHat", "totallyUnknown", "Beanie"]) {
    assert.equal(parseOutfit(raw), "none", JSON.stringify(raw));
  }
});

test("missing or malformed preferences mean auto", () => {
  for (const raw of [undefined, null, 42, true, {}, ["beanie"], ""]) {
    assert.equal(parseOutfit(raw), "auto", String(raw));
  }
});

test("preferences from before the wardrobe start on auto", () => {
  assert.equal(DEFAULT_SETTINGS.mochiOutfit, "auto");
  // What main.ts does with a settings.json that has no mochiOutfit key.
  const old = { soundEnabled: false, model: "x" };
  const merged = { ...DEFAULT_SETTINGS, ...old };
  assert.equal(parseOutfit(merged.mochiOutfit), "auto");
});

test("the wardrobe header names the hovered outfit, else the current choice", () => {
  const d = day(2026, 10, 15);
  assert.equal(wardrobeHeader(null, "auto", d), "Auto · Scarf");
  assert.equal(wardrobeHeader(null, "crown", d), "Crown");
  assert.equal(wardrobeHeader("auto", "crown", d), "Auto · follows the seasons (now: Scarf)");
  assert.equal(wardrobeHeader("headphones", "auto", d), "Headphones");
  assert.equal(wardrobeHeader(null, "auto", day(2026, 5, 1)), "Auto · None");
});

test("the per-frame season lookup follows the calendar day", () => {
  const cache = new SeasonCache();
  assert.equal(cache.get("auto", day(2026, 9, 30)), "none");
  assert.equal(cache.get("auto", new Date(2026, 9, 1, 0, 0, 1)), "scarf");
  assert.equal(cache.get("crown", day(2026, 10, 1)), "crown");
  assert.equal(cache.get("auto", day(2026, 12, 2)), "beanie");
});
