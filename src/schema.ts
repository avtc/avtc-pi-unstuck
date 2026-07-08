// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Unstuck settings schema (2 fields), rendered via the `/unstuck:settings`
 * command (avtc-pi-settings-ui).
 *
 * - `searchTimeoutMs`: timeout applied to search tools — the `find`/`grep`
 *   tools (watchdog abort) and search bash commands (native bash `timeout`).
 * - `bashTimeoutMs`: timeout applied to ANY bash command. For a search bash
 *   command, the SHORTER of the two takes effect.
 *
 * Both are `duration` settings: `null` means Infinite (no limit). Values are
 * stored in milliseconds (settings-ui convention); the bash tool's native
 * `timeout` input field expects seconds, so conversion happens at the injection
 * site (see src/search-timeout.ts).
 */

import type { SettingsSchema } from "avtc-pi-settings-ui";
import { settingsFilePaths } from "avtc-pi-settings-ui";

/** Effective timeouts configuration. `null` = Infinite (no limit). */
export interface UnstuckSettings {
  searchTimeoutMs: number | null;
  bashTimeoutMs: number | null;
}

/** Env var used by settings-ui for serialization + reload survival. */
export const UNSTUCK_SETTINGS_ENV_VAR = "PI_SETTINGS_UNSTUCK";

// ── Preset pairs (label → value, ms). Order = display order. ───────────────

const SEARCH_TIMEOUT_PRESETS = [
  ["1m", 60_000],
  ["2m", 120_000],
  ["5m", 300_000],
  ["10m", 600_000],
  ["Infinite", null],
] as const;

const BASH_TIMEOUT_PRESETS = [
  ["5m", 300_000],
  ["10m", 600_000],
  ["15m", 900_000],
  ["30m", 1_800_000],
  ["1h", 3_600_000],
  ["Infinite", null],
] as const;

// ── Schema ──────────────────────────────────────────────────────────────────

export const UNSTUCK_SCHEMA: SettingsSchema = {
  settings: [
    {
      id: "searchTimeoutMs",
      label: "Search timeout",
      description:
        "Timeout for search tools (find/grep tools and search bash commands). " +
        "For a search bash command, the shorter of this and the bash timeout applies. " +
        "Infinite = no limit.",
      type: "duration",
      defaultValue: 120_000, // 2 minutes — matches the previous built-in search timeout
      // min:1 guards the grep/find watchdog — a 0 value arms setTimeout(fn, 0) and instantly
      // aborts every search before it can run.
      min: 1,
      presets: SEARCH_TIMEOUT_PRESETS,
    },
    {
      id: "bashTimeoutMs",
      label: "Bash timeout",
      description:
        "Timeout for any bash command. For a search bash command, the shorter of this and the search timeout applies. " +
        "Infinite = no limit.",
      type: "duration",
      defaultValue: 600_000, // 10 minutes — the default cap for any bash command
      // min:1 so a 0/negative value resets to the default on load — without it, the bash path
      // floors 0 to a 1s timeout that kills every command almost instantly.
      min: 1,
      presets: BASH_TIMEOUT_PRESETS,
    },
  ],
  tabs: [
    {
      label: "Timeouts",
      settingIds: ["searchTimeoutMs", "bashTimeoutMs"],
    },
  ],
  ...settingsFilePaths("avtc-pi-unstuck"),
};
