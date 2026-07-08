// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * avtc-pi-unstuck — Auto-continue on empty model responses + tool timeouts.
 *
 * 1. Detects empty model responses (no text content and no tool calls;
 *    thinking alone counts as empty) and automatically sends "continue"
 *    to unstuck the agent.
 * 2. Enforces configurable timeouts (edited via `/unstuck:settings`,
 *    powered by avtc-pi-settings-ui):
 *    - A bash timeout (default 10m) applied to ANY `bash` command via its
 *      native `timeout` field.
 *    - A search timeout (default 2m) applied to search tools — `grep`/`find`
 *      (watchdog abort) and search bash commands. For a search bash command,
 *      the shorter of the two takes effect.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEmptyResponseHandler } from "./src/empty-response.js";
import { registerSearchToolTimeouts } from "./src/search-timeout.js";
import { getUnstuckSettings, initUnstuckSettings } from "./src/settings-ui.js";

// Idempotent wiring guard. unstuck can be bundled into the avtc-pi umbrella
// AND installed standalone — whichever copy loads first wires, the rest no-op.
const WIRED_KEY = "__avtcPiUnstuckWired";
type GlobalWithWired = typeof globalThis & { [WIRED_KEY]?: boolean };

export default function (pi: ExtensionAPI) {
  const g = globalThis as GlobalWithWired;
  if (g[WIRED_KEY]) return;
  g[WIRED_KEY] = true;

  // Register the /unstuck:settings command + modal and load settings (registration time + every
  // session_start). The env var (PI_SETTINGS_UNSTUCK) survives /reload so live UI changes persist.
  initUnstuckSettings(pi);

  registerEmptyResponseHandler(pi);
  registerSearchToolTimeouts(pi, getUnstuckSettings);

  // pi re-evaluates extension modules fresh on /reload (jiti moduleCache:false),
  // but globalThis persists — so without a reset the guard would short-circuit
  // re-wiring and leave the extension dead after reload. Reset the flag on
  // session_shutdown so the next load re-wires.
  pi.on("session_shutdown", () => {
    (globalThis as GlobalWithWired)[WIRED_KEY] = false;
  });
}
