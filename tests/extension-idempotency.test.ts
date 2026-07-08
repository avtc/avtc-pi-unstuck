// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import entry from "../index.js";

/**
 * The entry guards against double-registration via a globalThis flag so the
 * package can be safely bundled into the avtc-pi umbrella AND installed
 * standalone — whichever loads first wires, the rest no-op.
 */
describe("unstuck entry (idempotent wiring)", () => {
  beforeEach(() => {
    delete (globalThis as { __avtcPiUnstuckWired?: boolean }).__avtcPiUnstuckWired;
  });
  afterEach(() => {
    delete (globalThis as { __avtcPiUnstuckWired?: boolean }).__avtcPiUnstuckWired;
    vi.restoreAllMocks();
  });

  function createMockPi() {
    return {
      on: vi.fn(),
      registerCommand: vi.fn(),
      events: { on: vi.fn(), emit: vi.fn() },
    } as unknown as ExtensionAPI;
  }

  it("wires on first call", () => {
    expect(() => entry(createMockPi())).not.toThrow();
  });

  it("is idempotent — second call no-ops", () => {
    const pi = createMockPi();
    entry(pi);
    expect(() => entry(pi)).not.toThrow();
  });

  it("sets the globalThis wired flag after first call", () => {
    const g = globalThis as { __avtcPiUnstuckWired?: boolean };
    expect(g.__avtcPiUnstuckWired).toBeUndefined();
    entry(createMockPi());
    expect(g.__avtcPiUnstuckWired).toBe(true);
  });

  // pi re-evaluates extension modules fresh on /reload (jiti moduleCache:false)
  // but globalThis persists, so an un-reset guard short-circuits re-wiring and
  // leaves the extension dead after reload. The entry must register a
  // session_shutdown handler that resets the flag so the next load re-wires.
  it("re-wires after session_shutdown (reload-safe)", () => {
    const g = globalThis as { __avtcPiUnstuckWired?: boolean };

    // Capture every pi.on handler so we can fire session_shutdown manually.
    const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
    const pi = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      }),
      registerCommand: vi.fn(),
      events: { on: vi.fn(), emit: vi.fn() },
    } as unknown as ExtensionAPI;

    // 1. First call — wires. Flag cycles undefined → true.
    expect(g.__avtcPiUnstuckWired).toBeUndefined();
    entry(pi);
    expect(g.__avtcPiUnstuckWired).toBe(true);

    // 2. Second call — no-op (idempotent). Flag stays true.
    entry(pi);
    expect(g.__avtcPiUnstuckWired).toBe(true);

    // 3. Fire every session_shutdown handler — entry's resets the flag to false.
    for (const h of handlers.session_shutdown ?? []) h();
    expect(g.__avtcPiUnstuckWired).toBe(false);

    // 4. Third call — re-wires after reload. Flag true again.
    entry(pi);
    expect(g.__avtcPiUnstuckWired).toBe(true);
  });
});
