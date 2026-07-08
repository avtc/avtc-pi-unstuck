// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Empty response detection and auto-continue.
 *
 * Detects when the model ends a turn without producing text output for the
 * user: tool calls and thinking alone don't count — the model must deliver a
 * text answer. This catches stalls where the model did work (tool calls,
 * thinking) but stopped without a final response. Automatically sends
 * escalating prompts ("continue", "please continue") to unstuck the agent,
 * with a targeted prompt for length-limited stalls. After max retries,
 * notifies the user.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Max consecutive empty responses before escalating to user */
const MAX_EMPTY_RETRIES = 2;

/** Escalating prompts for empty responses (used for all stall patterns) */
const EMPTY_RESPONSE_PROMPTS = ["continue", "please continue"] as const;

/** Prompt for length-limited stalls — nudges the model toward shorter output */
const LENGTH_STALL_PROMPT =
  "Your response was cut off due to length. Please provide a shorter, more concise response." as const;

/** Structural shape of an assistant message used by the detection helpers. */
interface AssistantMessageLike {
  role?: string;
  content?: ReadonlyArray<{ type: string; text?: string } & { [key: string]: unknown }>;
  stopReason?: string;
  errorMessage?: string;
}

/**
 * Check if an assistant message produced no text output for the user.
 * Tool calls and thinking don't count as output — the model ended the turn
 * without delivering an answer. This catches stalls where the model did work
 * (tool calls, thinking) but stopped without a final text response.
 */
export function isEmptyResponse(msg: AssistantMessageLike): boolean {
  // Error / aborted responses are not "empty" — they have their own handling
  if (msg.stopReason === "error" || msg.stopReason === "aborted") return false;
  // A response is a stall if it produced no text answer. Tool calls and
  // thinking don't count — the model stopped without delivering output.
  for (const block of msg.content ?? []) {
    if (block.type === "text" && block.text && block.text.trim()) return false;
  }
  return true;
}

/**
 * Check if the model was cut off by the token length limit without
 * producing text output. pi does NOT auto-continue on `length` cut-offs
 * (verified in agent-loop.js: only error/aborted stop the loop early), so
 * we must nudge the model ourselves. Any length cut-off with no text answer
 * gets the targeted shorter-response prompt.
 */
export function isLengthStalled(msg: AssistantMessageLike): boolean {
  if (msg.stopReason !== "length") return false;
  return isEmptyResponse(msg);
}

/**
 * Register the empty response auto-continue handler.
 * Listens on agent_start (reset counter) and agent_end (detect + continue).
 *
 * Detects stalls where the model produced no output beyond thinking content.
 * Length-limited stalls get a targeted prompt about shorter responses;
 * all other empty responses use escalating "continue" prompts.
 */
export function registerEmptyResponseHandler(pi: ExtensionAPI): void {
  let consecutiveEmptyResponses = 0;

  pi.on("agent_start", async () => {
    consecutiveEmptyResponses = 0;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!event.messages?.length) return;

    let lastAssistant: AssistantMessageLike | undefined;
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const m = event.messages[i];
      if (m && m.role === "assistant") {
        lastAssistant = m as unknown as AssistantMessageLike;
        break;
      }
    }
    if (!lastAssistant) return;

    if (!isEmptyResponse(lastAssistant)) {
      // Non-empty response — reset counter
      consecutiveEmptyResponses = 0;
      return;
    }

    // Empty response detected — escalate
    consecutiveEmptyResponses++;

    // Check for length-limited stall first — use targeted prompt about shorter responses
    const prompt = isLengthStalled(lastAssistant)
      ? LENGTH_STALL_PROMPT
      : EMPTY_RESPONSE_PROMPTS[consecutiveEmptyResponses - 1];

    if (prompt && consecutiveEmptyResponses <= MAX_EMPTY_RETRIES) {
      // Send auto-continue
      try {
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      } catch {
        // If sending fails (e.g., session ended), silently ignore
      }
      return;
    }

    // Max retries exceeded — notify the user.
    // pi-notification (if installed) already sends a completion bell/Telegram
    // on every agent_end, so the user is alerted even when away from the terminal.
    if (ctx.hasUI) {
      ctx.ui.notify(
        "⚠ Model produced empty response 3 times in a row. It may be stuck. Consider checking vLLM logs or adjusting config.",
        "warning",
      );
    }
  });
}
