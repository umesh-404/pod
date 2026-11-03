// Settings search in the Pod window: matches every setting of the
// island in the app's language, whatever the accents and case.
// Port of SettingsSearch.swift and SettingsSearchMatch.swift.

import { t } from "../i18n/i18n";
import type { PageId } from "./shell";

export interface SettingsSearchEntry {
  /** The box's anchor, unique. */
  id: string;
  page: PageId;
  /** The box's title (catalog key, or a name that is never translated). */
  title: string;
  /** The labels inside the box (catalog keys). */
  terms: string[];
}

export interface SettingsSearchHit {
  entry: SettingsSearchEntry;
  label?: string;
  id: string;
}

export type MatchResult =
  | { kind: "box" }
  | { kind: "label"; label: string };

/**
 * Normalizes a string for searching: case-insensitive, diacritic/accent-insensitive,
 * trimmed of leading/trailing whitespace.
 */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * The words of a query, normalized.
 */
export function words(query: string): string[] {
  return query
    .split(/\s+/)
    .map(normalize)
    .filter((w) => w.length > 0);
}

/**
 * Matches a list of query words against a box's title, page and inner labels.
 * Returns null when the box doesn't have every word.
 */
export function match(
  wordList: string[],
  title: string,
  page: string,
  labels: string[]
): MatchResult | null {
  if (wordList.length === 0) return null;
  const head = normalize(title + " " + page);
  const texts = labels.map(normalize);
  const all = [head, ...texts].join(" ");
  if (!wordList.every((w) => all.includes(w))) return null;
  if (wordList.every((w) => head.includes(w))) return { kind: "box" };

  // The label with the most of the words, the first one when tied.
  let bestIndex = -1;
  let bestCount = 0;
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const count = wordList.filter((w) => text.includes(w)).length;
    if (count > 0 && count > bestCount) {
      bestIndex = i;
      bestCount = count;
    }
  }

  if (bestIndex < 0) return { kind: "box" };
  return { kind: "label", label: labels[bestIndex] };
}

export const SETTINGS_ENTRIES: SettingsSearchEntry[] = [
  // General (the ids are the anchors main.ts puts on the rows)
  { id: "general.workspace", page: "general", title: "Workspace", terms: ["Folder", "Choose ffmpeg…", "Copy to workspace"] },
  { id: "general.sound", page: "general", title: "Sound", terms: ["Volume", "Open sounds folder", "Reload sounds"] },
  { id: "general.hover", page: "general", title: "Open on hover", terms: [] },
  { id: "general.clock", page: "general", title: "Show clock in the island", terms: [] },
  { id: "general.autoclose", page: "general", title: "Auto-close", terms: [] },
  { id: "general.display", page: "general", title: "Island lives on", terms: ["Main display", "Display under the cursor"] },
  { id: "general.startup", page: "general", title: "Launch at startup", terms: [] },
  { id: "general.update", page: "general", title: "Updates", terms: ["Check now"] },
  { id: "general.language", page: "general", title: "Language", terms: [] },

  // Notch
  {
    id: "notch.right", page: "notch", title: "Right side of the notch",
    terms: [
      "File jobs", "Focus timer", "Next meeting", "Now playing", "Shelf", "System glance",
      "Camera and microphone", "New downloads", "Dev servers", "Seconds per item",
    ],
  },
  { id: "notch.calendar", page: "notch", title: "Calendar links", terms: ["Next meeting", "Paste a calendar link", "Test"] },
  { id: "notch.focus", page: "notch", title: "Focus timer", terms: ["Focus", "Break"] },

  // Features
  {
    id: "features.drop", page: "features", title: "Drop actions",
    terms: ["Convert File Format", "Zip / Unzip", "Resize image", "PDF tools", "Copy to workspace"],
  },
  { id: "features.tabs", page: "features", title: "Island tabs", terms: ["Shelf", "Reminders", "Notes", "Tools"] },
  { id: "features.notch", page: "features", title: "Notch", terms: ["Camera and microphone"] },
  {
    id: "features.tools", page: "features", title: "Tools",
    terms: ["Screenshot to shelf", "Focus timer", "Smart clipboard", "Dev servers"],
  },

  // Shortcuts
  { id: "shortcuts.global", page: "shortcuts", title: "From anywhere", terms: ["Reset to defaults"] },
  { id: "shortcuts.island", page: "shortcuts", title: "In the open island", terms: [] },
];

/**
 * Searches the settings index given a query string and page title resolver.
 */
export function searchSettings(
  query: string,
  getPageTitle: (page: PageId) => string,
  entries: SettingsSearchEntry[] = SETTINGS_ENTRIES
): SettingsSearchHit[] {
  const qWords = words(query);
  if (qWords.length === 0) return [];
  const boxes: SettingsSearchHit[] = [];
  const labels: SettingsSearchHit[] = [];

  for (const entry of entries) {
    const titleText = t(entry.title);
    const pageText = getPageTitle(entry.page);
    const labelTexts = entry.terms.map((k) => t(k));
    const res = match(qWords, titleText, pageText, labelTexts);
    if (!res) continue;
    if (res.kind === "box") {
      boxes.push({ entry, id: entry.id });
    } else {
      labels.push({ entry, label: res.label, id: `${entry.id}|${res.label}` });
    }
  }

  return [...boxes, ...labels].slice(0, 30);
}
