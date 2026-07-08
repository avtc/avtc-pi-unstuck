// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The single, canonical unstuck-settings handle.
 *
 * Registered once here (rather than in the entry point) so every module reads settings through
 * the same accessor. {@link initUnstuckSettings} is called from the extension's activate function
 * (where `pi` is available); until then the handle is `undefined`, which is fine because all reads
 * happen at runtime (after activate). Callers read {@link getUnstuckSettings}; no consumer
 * re-parses or re-normalizes the env var.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettingsCommand, type SettingsHandle } from "avtc-pi-settings-ui";
import { UNSTUCK_SCHEMA, UNSTUCK_SETTINGS_ENV_VAR, type UnstuckSettings } from "./schema.js";

let handle: SettingsHandle<UnstuckSettings> | undefined;

/**
 * Test-only override for the settings read (DI/mock pattern): when set, {@link getUnstuckSettings}
 * returns this instead of the real handle. Set up in tests before the SUT runs; cleared by
 * {@link _resetGetUnstuckSettings}.
 */
let _getSettingsOverride: (() => UnstuckSettings) | null = null;

/** Test-only: inject a mock settings source (pass `null` to restore the real handle). */
export function _setGetUnstuckSettings(fn: (() => UnstuckSettings) | null): void {
  _getSettingsOverride = fn;
}

/** Test-only: clear the mock override (restore real-handle reads). */
export function _resetGetUnstuckSettings(): void {
  _getSettingsOverride = null;
}

/**
 * Register the /unstuck:settings command + modal and create the settings handle.
 * Must be called from the extension's activate function (needs `pi`). Loads settings
 * immediately (registration time) and on every session_start.
 */
export function initUnstuckSettings(pi: ExtensionAPI): void {
  handle = registerSettingsCommand<UnstuckSettings>(pi, UNSTUCK_SCHEMA, {
    commandName: "unstuck:settings",
    title: "Unstuck Settings",
    titleRight: "avtc-pi-unstuck",
    envVar: UNSTUCK_SETTINGS_ENV_VAR,
  });
}

/** Read the current unstuck settings (normalized by the schema). */
export function getUnstuckSettings(): UnstuckSettings {
  if (_getSettingsOverride) return _getSettingsOverride();
  if (!handle) throw new Error("unstuck settings not initialized — initUnstuckSettings not called");
  return handle.getSettings();
}
