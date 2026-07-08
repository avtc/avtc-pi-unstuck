// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { isEmptyResponse, isLengthStalled, registerEmptyResponseHandler } from "../src/empty-response.js";

describe("isEmptyResponse", () => {
  it("returns true for a message with no content", () => {
    expect(isEmptyResponse({ role: "assistant", content: [] })).toBe(true);
  });

  it("returns true for a message with undefined content", () => {
    expect(isEmptyResponse({ role: "assistant" })).toBe(true);
  });

  it("returns true for a message with only thinking content", () => {
    // Real ThinkingContent shape: the field is `thinking`, not `text`.
    expect(
      isEmptyResponse({
        role: "assistant",
        content: [{ type: "thinking", thinking: "Let me think about this..." }],
      }),
    ).toBe(true);
  });

  it("returns true for thinking truncated mid-way by the token limit", () => {
    // The model hit max_tokens mid-thought and ended the turn with no answer/tool call.
    expect(
      isEmptyResponse({
        role: "assistant",
        stopReason: "length",
        content: [{ type: "thinking", thinking: "So far I have determined that" }],
      }),
    ).toBe(true);
  });

  it("returns true for a message with only empty text", () => {
    expect(
      isEmptyResponse({
        role: "assistant",
        content: [{ type: "text", text: "   " }],
      }),
    ).toBe(true);
  });

  it("returns false for a message with text content", () => {
    expect(
      isEmptyResponse({
        role: "assistant",
        content: [{ type: "text", text: "Here is the answer" }],
      }),
    ).toBe(false);
  });

  it("returns true for a message with only tool calls (no text output)", () => {
    // Tool calls don't count as output: the model did work but delivered no answer.
    expect(
      isEmptyResponse({
        role: "assistant",
        content: [{ type: "toolCall", toolName: "read", input: { path: "file.ts" } }],
      }),
    ).toBe(true);
  });

  it("returns true for a message with thinking + tool calls (no text output)", () => {
    // Interleaved thinking + tool calls but no text answer = stall.
    expect(
      isEmptyResponse({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me check..." },
          { type: "toolCall", toolName: "read", input: { path: "file.ts" } },
        ],
      }),
    ).toBe(true);
  });

  it("returns false for error responses", () => {
    expect(
      isEmptyResponse({
        role: "assistant",
        stopReason: "error",
        errorMessage: "Something went wrong",
      }),
    ).toBe(false);
  });

  it("returns false for aborted responses", () => {
    expect(
      isEmptyResponse({
        role: "assistant",
        stopReason: "aborted",
      }),
    ).toBe(false);
  });

  it("returns false for a message with thinking + non-empty text", () => {
    expect(
      isEmptyResponse({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Analyzing..." },
          { type: "text", text: "The result is 42" },
        ],
      }),
    ).toBe(false);
  });
});

describe("isLengthStalled", () => {
  it("returns true when stopReason is length with thinking but no text", () => {
    expect(
      isLengthStalled({
        stopReason: "length",
        content: [{ type: "thinking", thinking: "I was analyzing the results and" }],
      }),
    ).toBe(true);
  });

  it("returns true when length-stopped with thinking and whitespace-only text", () => {
    // text.trim() makes whitespace-only text not count as real output
    expect(
      isLengthStalled({
        stopReason: "length",
        content: [
          { type: "thinking", thinking: "Analyzing..." },
          { type: "text", text: "   " },
        ],
      }),
    ).toBe(true);
  });

  it("returns true when length-stopped with thinking and tool calls but no text", () => {
    // The user's case: interleaved thinking + tool calls, cut off at length,
    // with no text answer. Tool calls don't count as output, so it's a stall.
    expect(
      isLengthStalled({
        stopReason: "length",
        content: [
          { type: "toolCall", toolName: "read", input: { path: "file.ts" } },
          { type: "thinking", thinking: "Now I need to" },
        ],
      }),
    ).toBe(true);
  });

  it("returns false when stopReason is not length", () => {
    expect(
      isLengthStalled({
        stopReason: "stop",
        content: [{ type: "thinking", thinking: "Thinking..." }],
      }),
    ).toBe(false);
  });

  it("returns false when message has text content (even with length stop)", () => {
    expect(
      isLengthStalled({
        stopReason: "length",
        content: [
          { type: "thinking", thinking: "Reasoning..." },
          { type: "text", text: "Here is a partial answer" },
        ],
      }),
    ).toBe(false);
  });

  it("returns true when length-stopped with only tool calls (no text, no thinking)", () => {
    // Any length cut-off with no text answer is a stall, regardless of
    // whether the model was mid-thinking.
    expect(
      isLengthStalled({
        stopReason: "length",
        content: [{ type: "toolCall", toolName: "read", input: {} }],
      }),
    ).toBe(true);
  });

  it("returns false for undefined stopReason", () => {
    expect(
      isLengthStalled({
        content: [{ type: "thinking", thinking: "Thinking..." }],
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// registerEmptyResponseHandler — agent_end detection + auto-continue
// ---------------------------------------------------------------------------

type AnyHandler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown> | unknown;

interface FakePi {
  handlers: Map<string, AnyHandler[]>;
  sent: Array<{ content: string; options?: unknown }>;
  notified: Array<{ msg: string; level: string }>;
  api: ExtensionAPI;
  ctx: { hasUI: boolean; ui: { notify: (m: string, l: string) => void } };
}

function makeFakePi(): FakePi {
  const pi: FakePi = {
    handlers: new Map<string, AnyHandler[]>(),
    sent: [],
    notified: [],
    api: undefined as unknown as ExtensionAPI,
    ctx: undefined as unknown as FakePi["ctx"],
  };
  pi.ctx = {
    hasUI: true,
    ui: { notify: (msg: string, level: string) => pi.notified.push({ msg, level }) },
  };
  pi.api = {
    on: (event: string, handler: AnyHandler) => {
      const list = pi.handlers.get(event) ?? [];
      list.push(handler);
      pi.handlers.set(event, list);
    },
    sendUserMessage: (content: string, options?: unknown) => {
      pi.sent.push({ content, options });
    },
  } as unknown as ExtensionAPI;
  return pi;
}

/** Emit an event to all registered handlers (resolves any returned promises). */
async function emit(pi: FakePi, event: string, payload: Record<string, unknown>): Promise<void> {
  for (const h of pi.handlers.get(event) ?? []) await h(payload, pi.ctx);
}

/** Build an agent_end payload with a single assistant message. */
function agentEndWith(content: unknown[], stopReason: string | undefined): Record<string, unknown> {
  return { messages: [{ role: "assistant", content, stopReason }] };
}

describe("registerEmptyResponseHandler", () => {
  it("sends the length-stall prompt for a length-limited thinking-only response", async () => {
    const pi = makeFakePi();
    registerEmptyResponseHandler(pi.api);
    await emit(pi, "agent_start", {});
    await emit(pi, "agent_end", agentEndWith([{ type: "thinking", thinking: "I was analyzing and" }], "length"));
    expect(pi.sent).toHaveLength(1);
    expect(pi.sent[0].content).toBe(
      "Your response was cut off due to length. Please provide a shorter, more concise response.",
    );
    expect(pi.sent[0].options).toEqual({ deliverAs: "followUp" });
  });

  it("sends 'continue' for a generic thinking-only empty response", async () => {
    const pi = makeFakePi();
    registerEmptyResponseHandler(pi.api);
    await emit(pi, "agent_start", {});
    await emit(pi, "agent_end", agentEndWith([{ type: "thinking", thinking: "Hmm..." }], "stop"));
    expect(pi.sent).toHaveLength(1);
    expect(pi.sent[0].content).toBe("continue");
    expect(pi.sent[0].options).toEqual({ deliverAs: "followUp" });
  });

  it("escalates to 'please continue' on the second consecutive empty response", async () => {
    const pi = makeFakePi();
    registerEmptyResponseHandler(pi.api);
    await emit(pi, "agent_start", {});
    await emit(pi, "agent_end", agentEndWith([{ type: "thinking", thinking: "Hmm..." }], "stop"));
    await emit(pi, "agent_end", agentEndWith([{ type: "thinking", thinking: "Still thinking..." }], "stop"));
    expect(pi.sent).toHaveLength(2);
    expect(pi.sent[0].content).toBe("continue");
    expect(pi.sent[1].content).toBe("please continue");
  });

  it("does not send anything and resets the counter for a non-empty response", async () => {
    const pi = makeFakePi();
    registerEmptyResponseHandler(pi.api);
    await emit(pi, "agent_start", {});
    // First: empty (counter -> 1, sends continue)
    await emit(pi, "agent_end", agentEndWith([{ type: "thinking", thinking: "x" }], "stop"));
    // Then: non-empty (has text) — resets counter, sends nothing
    await emit(pi, "agent_end", agentEndWith([{ type: "text", text: "Here is the answer" }], "stop"));
    expect(pi.sent).toHaveLength(1); // only the first continue
    // Next empty should be 'continue' again (counter was reset)
    await emit(pi, "agent_end", agentEndWith([{ type: "thinking", thinking: "x" }], "stop"));
    expect(pi.sent).toHaveLength(2);
    expect(pi.sent[1].content).toBe("continue");
  });

  it("treats a thinking + tool-call response with no text as a length stall", async () => {
    // The user's case: thinking + tool calls but no text answer, cut off at length.
    const pi = makeFakePi();
    registerEmptyResponseHandler(pi.api);
    await emit(pi, "agent_start", {});
    await emit(
      pi,
      "agent_end",
      agentEndWith(
        [
          { type: "toolCall", toolName: "read", input: { path: "f.ts" } },
          { type: "thinking", thinking: "Now I need to" },
        ],
        "length",
      ),
    );
    expect(pi.sent).toHaveLength(1);
    expect(pi.sent[0].content).toBe(
      "Your response was cut off due to length. Please provide a shorter, more concise response.",
    );
  });

  it("notifies the user after max consecutive empty responses and sends nothing further", async () => {
    const pi = makeFakePi();
    registerEmptyResponseHandler(pi.api);
    await emit(pi, "agent_start", {});
    // 1st empty -> continue
    await emit(pi, "agent_end", agentEndWith([{ type: "thinking", thinking: "a" }], "stop"));
    // 2nd empty -> please continue
    await emit(pi, "agent_end", agentEndWith([{ type: "thinking", thinking: "b" }], "stop"));
    // 3rd empty -> over the cap: notify, no message sent
    await emit(pi, "agent_end", agentEndWith([{ type: "thinking", thinking: "c" }], "stop"));
    expect(pi.sent).toHaveLength(2); // continue + please continue only
    expect(pi.notified).toHaveLength(1);
    expect(pi.notified[0].level).toBe("warning");
    expect(pi.notified[0].msg).toContain("empty response");
  });
});
