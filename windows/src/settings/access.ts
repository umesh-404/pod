import type { Settings } from "../core/state";

/** How a settings page reads the settings and writes a change (main.ts saves it). */
export interface SettingsAccess {
  get(): Settings;
  /** Merges `patch` into the settings and saves them. */
  set(patch: Partial<Settings>): void;
}
