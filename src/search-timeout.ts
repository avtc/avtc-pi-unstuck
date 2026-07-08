// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Bash + search tool timeout enforcement.
 *
 * Two configurable timeouts (src/schema.ts, edited via `/unstuck:settings`):
 *
 * - `bashTimeoutMs`: applied to ANY `bash` command via the tool's native
 *  `timeout` input field (seconds). Default 10m.
 * - `searchTimeoutMs`: applied to search tools — the `grep`/`find` tools
 *  (watchdog abort, since they have no native timeout field) and search bash
 *  commands. Default 2m.
 *
 * For a search bash command, the SHORTER of the two takes effect. Either may be
 * `null` (Infinite) to disable that limit. An explicit model-provided bash
 * `timeout` is always respected (never overridden).
 *
 * The bash command detection uses command decomposition (a port of
 * pi-parallel-work-guardrail's decompose.ts) to split compound shell commands
 * before checking each subcommand for search tools.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatHumanDuration } from "avtc-pi-settings-ui";
import type { UnstuckSettings } from "./schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The bash tool's `timeout` input field is in seconds. */
const MS_PER_SECOND = 1000;
/** Minimum injectable bash timeout in seconds (never inject 0 — it would kill instantly). */
const MIN_TIMEOUT_SECONDS = 1;

/** Max consecutive search overruns before escalating to the user. */
const MAX_SEARCH_ABORTS = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tool input shape with optional timeout (bash only). */
export interface ToolInputLike {
  command?: string;
  path?: string;
  pattern?: string;
  query?: string;
  timeout?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Command decomposition (port of pi-parallel-work-guardrail decompose.ts)
// ---------------------------------------------------------------------------

/**
 * Split a compound shell command into individual subcommands.
 * Handles `&&`, `||`, `;`, `|`, `&`, newlines, subshells, quoting,
 * command substitution, and backtick substitution.
 */
function decompose(input: string): string[] {
  const results: string[] = [];
  splitInto(input, results);
  return results.filter((s) => s.trim() !== "");
}

/**
 * Copy a single- or double-quoted region of `input` starting at the quote char at
 * index `i`, returning the full region (delimiters included) and the index just
 * past the closing quote. Single quotes have no escaping; double quotes honor
 * `\"` (and `\<any>` is copied verbatim). If the string is unterminated, the
 * region extends to end-of-input.
 *
 * Shared by {@link scanParenBody} and {@link splitInto} so the quote-handling
 * logic (≈30 lines) exists in exactly one place.
 */
function readQuoted(input: string, i: number): { text: string; end: number } {
  const quote = input[i];
  let text = quote;
  let j = i + 1;
  while (j < input.length && input[j] !== quote) {
    if (quote === '"' && input[j] === "\\" && j + 1 < input.length) {
      text += input[j] + input[j + 1];
      j += 2;
      continue;
    }
    text += input[j];
    j++;
  }
  if (j < input.length) {
    text += input[j];
    j++;
  }
  return { text, end: j };
}

/**
 * Scan the body of a balanced, quote-aware parenthesised group — a subshell
 * `` or command substitution `$` — starting just past the opening
 * `(`. Returns the inner text (delimiters excluded) and the index just past
 * the closing `)`. Single/double-quoted regions are copied verbatim so parens
 * inside strings don't skew depth; nested `(` / `)` are tracked.
 *
 * Shared by the subshell and $ branches of splitInto so their bodies are
 * decomposed identically — which is what lets a search tool hidden in
 * `var=$(grep)` be detected just like one in `(grep)`.
 */
function scanParenBody(input: string, start: number): { body: string; end: number } {
  let i = start;
  let depth = 1;
  let body = "";
  while (i < input.length && depth > 0) {
    if (input[i] === "'" || input[i] === '"') {
      const region = readQuoted(input, i);
      body += region.text;
      i = region.end;
      continue;
    }
    if (input[i] === "(") depth++;
    if (input[i] === ")") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
    if (depth > 0) {
      body += input[i];
      i++;
    }
  }
  return { body, end: i };
}

/**
 * Recursive splitter — appends subcommand fragments into `out`.
 */
function splitInto(input: string, out: string[]): void {
  let buf = "";
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Single- or double-quoted string ("..." honors \" escapes) — copy verbatim
    // so quotes inside don't skew separator/depth tracking. Shared logic via readQuoted.
    if (ch === "'" || ch === '"') {
      const region = readQuoted(input, i);
      buf += region.text;
      i = region.end;
      continue;
    }

    // Backslash escape — skip next character
    if (ch === "\\" && i + 1 < input.length) {
      buf += ch + input[i + 1];
      i += 2;
      continue;
    }

    // Command substitution $ — recurse into the body so ANY search tool
    // hidden inside (e.g. `hits=$(grep)`, `n=$(find... | wc -l)`) is
    // detected. Delimiters are dropped and the body is decomposed in place
    // via the same quote-aware scan as a subshell.
    if (ch === "$" && i + 1 < input.length && input[i + 1] === "(") {
      const group = scanParenBody(input, i + 2); // skip "$("
      i = group.end;
      splitInto(group.body, out);
      continue;
    }

    // Backtick command substitution — recurse into the body so ANY search
    // tool hidden inside (e.g. `` hits=`grep...` ``) is detected. Backslash
    // escapes are honored; delimiters are dropped and the body is decomposed
    // in place (same rationale as $ above).
    if (ch === "`") {
      i++; // skip opening backtick
      let inner = "";
      while (i < input.length && input[i] !== "`") {
        if (input[i] === "\\" && i + 1 < input.length) {
          inner += input[i] + input[i + 1];
          i += 2;
          continue;
        }
        inner += input[i];
        i++;
      }
      if (i < input.length) i++; // skip closing backtick
      splitInto(inner, out);
      continue;
    }

    // Subshell — drop delimiters and decompose the body in place.
    if (ch === "(") {
      const group = scanParenBody(input, i + 1); // skip "("
      i = group.end;
      splitInto(group.body, out);
      continue;
    }

    // Newline / CRLF → separator
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && i + 1 < input.length && input[i + 1] === "\n") {
        i += 2;
      } else {
        i++;
      }
      out.push(buf);
      buf = "";
      continue;
    }

    // Multi-char separators: &&, ||
    if (ch === "&" && i + 1 < input.length && input[i + 1] === "&") {
      out.push(buf);
      buf = "";
      i += 2;
      continue;
    }
    if (ch === "|" && i + 1 < input.length && input[i + 1] === "|") {
      out.push(buf);
      buf = "";
      i += 2;
      continue;
    }

    // Single-char separators:;, |, &
    if (ch === ";") {
      out.push(buf);
      buf = "";
      i++;
      continue;
    }
    if (ch === "|") {
      out.push(buf);
      buf = "";
      i++;
      continue;
    }
    if (ch === "&") {
      out.push(buf);
      buf = "";
      i++;
      continue;
    }

    // Regular character
    buf += ch;
    i++;
  }

  if (buf.trim() !== "") {
    out.push(buf);
  }
}

// ---------------------------------------------------------------------------
// Search detection
// ---------------------------------------------------------------------------

/**
 * Regex that matches a subcommand starting with a search tool (Unix tools only,
 * since this runs against the `bash` tool). After decomposition, each subcommand
 * is a standalone command, so we only need to check if it starts with a search
 * tool name. `xargs <search-tool>` is handled separately (see XARGS_PREFIX_RE /
 * XARGS_SEARCH_RE) since xargs itself is not a search tool.
 */
const SEARCH_SUBCOMMAND_RE =
  /^\s*(?:sudo\s+)?(?:grep|egrep|fgrep|zgrep|find|rg|ripgrep|ag|silversearcher|ack|sift|fd|fdfind|fzf|locate|whereis|which)\b/i;

/** Matches a subcommand that begins with `xargs` (itself NOT a search tool). */
const XARGS_PREFIX_RE = /^\s*xargs\b/i;

/**
 * For a subcommand starting with `xargs`, check if the argument is a search tool
 * (e.g. `find. | xargs grep 'foo'`), since xargs alone is not a search.
 */
const XARGS_SEARCH_RE =
  /^\s*xargs\s+.*\b(?:grep|egrep|fgrep|zgrep|find|rg|ripgrep|ag|silversearcher|ack|sift|fd|fdfind|fzf|locate)\b/i;

/**
 * PowerShell content-search cmdlet and its alias (`Select-String` / `sls`).
 * Matched on the whole command (PowerShell structure differs from bash, and
 * it is commonly piped, e.g. `Get-ChildItem -Recurse | Select-String "foo"`).
 */
const POWERSHELL_SEARCH_RE = /\b(?:Select-String|sls)\b/i;

/**
 * Check if a bash command is a search operation.
 * Decomposes compound commands and checks each subcommand.
 */
export function isSearchCommand(command: string): boolean {
  if (POWERSHELL_SEARCH_RE.test(command)) return true;
  const subcommands = decompose(command);
  for (const sub of subcommands) {
    const trimmed = sub.trim();
    // xargs is not itself a search tool — only count it if its argument is one.
    if (XARGS_PREFIX_RE.test(trimmed)) {
      if (XARGS_SEARCH_RE.test(trimmed)) return true;
    } else if (SEARCH_SUBCOMMAND_RE.test(trimmed)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Timeout resolution (pure — unit-tested without settings infra)
// ---------------------------------------------------------------------------

/**
 * Convert milliseconds to the seconds value the bash tool's `timeout` field
 * expects. Rounds UP (ceil) so the command is never killed sooner than the
 * configured duration; floors at 1s to avoid an instant-kill 0.
 */
export function msToTimeoutSeconds(ms: number): number {
  return Math.max(MIN_TIMEOUT_SECONDS, Math.ceil(ms / MS_PER_SECOND));
}

/**
 * Minimum of two nullable durations. `null` (Infinite) loses to any finite
 * value; if both are Infinite the result is Infinite (null).
 */
export function minNullableMs(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * Resolve the bash tool `timeout` (seconds) for a command.
 *
 * - Search command: the SHORTER of the search and bash timeouts.
 * - Non-search command: the bash timeout.
 *
 * Returns `undefined` when no timeout applies (the relevant timeout(s) are
 * Infinite/null), so the caller can leave the field unset.
 */
export function resolveBashTimeoutSeconds(
  command: string,
  searchTimeoutMs: number | null,
  bashTimeoutMs: number | null,
): number | undefined {
  const effectiveMs = isSearchCommand(command) ? minNullableMs(searchTimeoutMs, bashTimeoutMs) : bashTimeoutMs;
  if (effectiveMs === null) return undefined;
  return msToTimeoutSeconds(effectiveMs);
}

/**
 * Returns true when an existing bash `timeout` is an explicit positive value
 * the model set — in that case it must be respected and never overridden.
 */
export function hasExplicitTimeout(input: ToolInputLike): boolean {
  return input.timeout !== undefined && input.timeout > 0;
}

// ---------------------------------------------------------------------------
// grep/find watchdog (no native timeout — abort the run on overrun)
// ---------------------------------------------------------------------------

/** Warning sent to the model after aborting a runaway grep/find. */
function buildAbortFollowUp(toolName: string, searchTimeoutMs: number): string {
  return (
    `${toolName} was aborted after ${formatHumanDuration(searchTimeoutMs)} — the search was likely too broad. ` +
    "Narrow it: scope the path to a specific subdirectory, use a more specific pattern, " +
    "add file-type filters (e.g. glob), or set a smaller limit."
  );
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

/**
 * Register the bash + search tool timeout handlers.
 *
 * - `bash`: injects a `timeout` (seconds) for ANY command using the bash/native
 *  timeout field. Search commands get the shorter of the search/bash timeout.
 *  An explicit model-provided timeout is always respected.
 * - `grep` / `find`: starts a watchdog; aborts the run and warns the model if
 *  the tool overruns the search timeout. After MAX_SEARCH_ABORTS consecutive
 *  overruns, stops auto-continuing and notifies the user.
 *
 * `getSettings` is injected so tests can stub the live settings without global
 * state; the entry point wires it to {@link getUnstuckSettings}.
 */
export function registerSearchToolTimeouts(pi: ExtensionAPI, getSettings: () => UnstuckSettings): void {
  /** Pending watchdog timers keyed by toolCallId. Cleared on tool_execution_end. */
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  /** toolCallIds whose watchdog fired (overran) — used to distinguish abort vs. success. */
  const abortedToolCallIds = new Set<string>();
  /** Consecutive search overruns in this session. Reset on a clean grep/find result. */
  let consecutiveSearchAborts = 0;

  function clearWatchdog(toolCallId: string): void {
    const timer = pending.get(toolCallId);
    if (timer) {
      clearTimeout(timer);
      pending.delete(toolCallId);
    }
  }

  // bash: native timeout injection (every command — search gets the shorter of the two).
  pi.on("tool_call", async (event) => {
    if ((event.toolName ?? "") !== "bash") return;
    const input = event.input as ToolInputLike;
    if (hasExplicitTimeout(input)) return; // respect an explicit model timeout
    const command = input.command ?? "";
    const { searchTimeoutMs, bashTimeoutMs } = getSettings();
    const seconds = resolveBashTimeoutSeconds(command, searchTimeoutMs, bashTimeoutMs);
    if (seconds !== undefined) {
      input.timeout = seconds;
    }
  });

  // grep / find: watchdog abort.
  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName ?? "";
    if (toolName !== "grep" && toolName !== "find") return;

    const { searchTimeoutMs } = getSettings();
    // Infinite search timeout → no watchdog (the tool may run unbounded).
    // (Validation of a raw non-string value is owned by settings-ui's load gate;
    // see the type-consolidation. unstuck reads number|null per schema.)
    if (searchTimeoutMs === null) return;

    const toolCallId = event.toolCallId;
    clearWatchdog(toolCallId); // defensive: never double-arm
    const timer = setTimeout(() => {
      pending.delete(toolCallId);
      abortedToolCallIds.add(toolCallId);
      consecutiveSearchAborts++;
      // The tool is hung — always abort to kill it.
      // The follow-up / notify below are best-effort: under a subagent
      // (ctx.hasUI === false) the notify is skipped and sendUserMessage may
      // no-op, but the abort still protects against hangs and the parent
      // regains control. Both calls are wrapped in try/catch.
      try {
        ctx.abort();
      } catch {
        // ctx may be stale (session replaced); ignore.
      }
      if (consecutiveSearchAborts > MAX_SEARCH_ABORTS) {
        // Over the cap — stop auto-continuing and tell the user.
        if (ctx.hasUI) {
          ctx.ui.notify(
            `⚠ ${toolName} timed out ${consecutiveSearchAborts} times in a row. ` +
              "Searches may be too broad for this workspace. Consider scoping the path or using a more specific pattern.",
            "warning",
          );
        }
        return;
      }
      // Under the cap — queue a follow-up so the model retries with a narrower search.
      try {
        pi.sendUserMessage(buildAbortFollowUp(toolName, searchTimeoutMs), {
          deliverAs: "followUp",
        });
      } catch {
        // Sending may fail if the session is gone; ignore.
      }
    }, searchTimeoutMs);
    pending.set(toolCallId, timer);
  });

  // Clear watchdog when the tool finishes within the limit.
  // A clean (non-aborted) grep/find result resets the consecutive-abort counter.
  pi.on("tool_execution_end", async (event) => {
    const wasAborted = abortedToolCallIds.has(event.toolCallId);
    abortedToolCallIds.delete(event.toolCallId);
    clearWatchdog(event.toolCallId);
    if (!wasAborted && (event.toolName === "grep" || event.toolName === "find")) {
      consecutiveSearchAborts = 0;
    }
  });

  // Hygiene: drop any lingering timers when the run/session ends.
  pi.on("turn_end", async () => {
    for (const id of Array.from(pending.keys())) clearWatchdog(id);
  });
  pi.on("session_shutdown", async () => {
    for (const id of Array.from(pending.keys())) clearWatchdog(id);
    consecutiveSearchAborts = 0;
    abortedToolCallIds.clear();
  });
}
