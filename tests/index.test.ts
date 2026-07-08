// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import unstuckExtension from "../index.js";
import { _resetGetUnstuckSettings, _setGetUnstuckSettings, type getUnstuckSettings } from "../src/settings-ui.js";

/**
 * Integration smoke test for the index.ts default export: invoking it wires up
 * the settings handle, the empty-response + timeout handlers, and the settings
 * command.
 */
describe("index.ts default export (integration wiring)", () => {
  const registeredCommands: string[] = [];
  const registeredEvents: string[] = [];

  // A mock settings source so the integration test never touches the real settings handle / env var.
  const mockSettings = (): ReturnType<typeof getUnstuckSettings> => ({
    searchTimeoutMs: 120_000,
    bashTimeoutMs: 600_000,
  });

  function makeFakePi(): ExtensionAPI {
    registeredCommands.length = 0;
    registeredEvents.length = 0;
    return {
      // subscribeToDialogCoordinator no-ops when events is absent.
      on: (event: string) => {
        registeredEvents.push(event);
      },
      registerCommand: (name: string) => {
        registeredCommands.push(name);
      },
    } as unknown as ExtensionAPI;
  }

  beforeEach(() => {
    _setGetUnstuckSettings(mockSettings);
  });

  afterEach(() => {
    _resetGetUnstuckSettings();
  });

  it("registers the /unstuck:settings command and the tool/agent lifecycle handlers", () => {
    unstuckExtension(makeFakePi());

    // The settings command is registered under the colon-namespaced name.
    expect(registeredCommands).toContain("unstuck:settings");
    // The empty-response + search-timeout handlers subscribe to these events.
    expect(registeredEvents).toContain("tool_call");
    expect(registeredEvents).toContain("tool_execution_end");
    expect(registeredEvents).toContain("turn_end");
    expect(registeredEvents).toContain("agent_start");
    expect(registeredEvents).toContain("agent_end");
    // registerSettingsCommand reloads on session_start.
    expect(registeredEvents).toContain("session_start");
  });
});
