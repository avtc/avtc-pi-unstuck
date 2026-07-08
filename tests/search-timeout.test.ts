// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnstuckSettings } from "../src/schema.js";
import type { ToolInputLike } from "../src/search-timeout.js";
import {
  hasExplicitTimeout,
  isSearchCommand,
  minNullableMs,
  msToTimeoutSeconds,
  registerSearchToolTimeouts,
  resolveBashTimeoutSeconds,
} from "../src/search-timeout.js";

// ---------------------------------------------------------------------------
// Test settings helpers
// ---------------------------------------------------------------------------

const DEFAULT_TEST_SETTINGS: UnstuckSettings = {
  searchTimeoutMs: 120_000,
  bashTimeoutMs: 600_000,
};

/** Build a live settings getter with required overrides (pass `{}` for defaults). */
function makeGetSettings(overrides: Partial<UnstuckSettings>): () => UnstuckSettings {
  const settings: UnstuckSettings = { ...DEFAULT_TEST_SETTINGS, ...overrides };
  return () => settings;
}

/** Every search tool isSearchCommand must detect — shared across the $ and backtick cases. */
const SEARCH_TOOLS = [
  "grep",
  "egrep",
  "fgrep",
  "zgrep",
  "find",
  "rg",
  "ripgrep",
  "ag",
  "silversearcher",
  "ack",
  "sift",
  "fd",
  "fdfind",
  "fzf",
  "locate",
  "whereis",
  "which",
] as const;

// ---------------------------------------------------------------------------
// isSearchCommand
// ---------------------------------------------------------------------------

describe("isSearchCommand", () => {
  it("detects grep at start of command", () => {
    expect(isSearchCommand("grep 'pattern' file.txt")).toBe(true);
    expect(isSearchCommand("grep -r 'foo' src/")).toBe(true);
  });

  it("detects find at start of command", () => {
    expect(isSearchCommand("find . -name '*.ts'")).toBe(true);
    expect(isSearchCommand("find src -type f")).toBe(true);
  });

  it("detects ripgrep", () => {
    expect(isSearchCommand("rg 'pattern'")).toBe(true);
    expect(isSearchCommand("ripgrep 'pattern'")).toBe(true);
  });

  it("detects ag/silversearcher", () => {
    expect(isSearchCommand("ag 'pattern'")).toBe(true);
    expect(isSearchCommand("silversearcher 'pattern'")).toBe(true);
  });

  it("detects fd/fzf", () => {
    expect(isSearchCommand("fd '*.ts'")).toBe(true);
    expect(isSearchCommand("fzf")).toBe(true);
  });

  it("detects locate/whereis", () => {
    expect(isSearchCommand("locate file.txt")).toBe(true);
    expect(isSearchCommand("whereis node")).toBe(true);
  });

  it("detects search commands after pipe", () => {
    expect(isSearchCommand("cat file.log | grep 'error'")).toBe(true);
    expect(isSearchCommand("ls -R | grep '*.ts'")).toBe(true);
    expect(isSearchCommand("echo 'hello' | fzf")).toBe(true);
  });

  it("returns false for non-search commands", () => {
    expect(isSearchCommand("echo hello")).toBe(false);
    expect(isSearchCommand("npm install")).toBe(false);
    expect(isSearchCommand("git status")).toBe(false);
    expect(isSearchCommand("cat file.txt")).toBe(false);
    expect(isSearchCommand("ls -la")).toBe(false);
  });

  it("returns false for empty command", () => {
    expect(isSearchCommand("")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(isSearchCommand("GREP 'pattern'")).toBe(true);
    expect(isSearchCommand("Find . -name '*.ts'")).toBe(true);
  });

  it("detects sudo prefix", () => {
    expect(isSearchCommand("sudo find / -name config")).toBe(true);
    expect(isSearchCommand("sudo grep 'root' /etc/passwd")).toBe(true);
  });

  it("detects search after && (and chain)", () => {
    expect(isSearchCommand("cd /src && grep 'foo' *.ts")).toBe(true);
    expect(isSearchCommand("npm install && find . -name '*.js' ")).toBe(true);
    expect(isSearchCommand("ls && rg 'pattern' src/")).toBe(true);
  });

  it("detects search after || (or chain)", () => {
    expect(isSearchCommand("ls *.ts || grep -r 'foo' .")).toBe(true);
    expect(isSearchCommand("cat file || find . -name 'backup'")).toBe(true);
  });

  it("detects search after ; (sequence)", () => {
    expect(isSearchCommand("cd /path ; grep 'foo' *.ts")).toBe(true);
    expect(isSearchCommand("echo done; find src -type f")).toBe(true);
  });

  it("detects search in xargs pipeline", () => {
    expect(isSearchCommand("find . -name '*.ts' | xargs grep 'foo'")).toBe(true);
    expect(isSearchCommand("ls -R | xargs grep 'TODO'")).toBe(true);
  });

  it("does not match xargs with non-search commands", () => {
    // xargs cat is not a search — no search tool in the command
    expect(isSearchCommand("ls | xargs cat")).toBe(false);
    // xargs echo is not a search
    expect(isSearchCommand("echo files | xargs echo")).toBe(false);
  });

  it("does not false-match 'grep' inside strings or arguments", () => {
    // "grep" as a file argument, not as a command
    expect(isSearchCommand("echo 'grep this line' > file.txt")).toBe(false);
    expect(isSearchCommand("cat grep_results.txt")).toBe(false);
    expect(isSearchCommand("cp file.txt grep_backup.txt")).toBe(false);
  });

  it("detects PowerShell Select-String", () => {
    expect(isSearchCommand('Select-String -Pattern "foo" .')).toBe(true);
    expect(isSearchCommand('Get-ChildItem -Recurse | Select-String "foo"')).toBe(true);
    expect(isSearchCommand("select-string -Pattern error *.log")).toBe(true);
  });

  it("detects PowerShell sls alias", () => {
    expect(isSearchCommand('sls -Pattern "foo" .')).toBe(true);
    expect(isSearchCommand('gci -Recurse | sls "foo"')).toBe(true);
  });

  it("does not false-match Select-String in non-search contexts", () => {
    // 'sls' as part of another word is not the alias
    expect(isSearchCommand("echo slsmith")).toBe(false);
    expect(isSearchCommand("cat Select-Strings-notes.txt")).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Command substitution: $ and backticks must be decomposed so that ANY
  // search tool hidden inside (the idiomatic `var=$(grep)`, loops, etc.)
  // is detected. This guards the whole SEARCH_SUBCOMMAND_RE tool set, not
  // just grep.
  // ---------------------------------------------------------------------

  it("detects every search tool assigned via $ command substitution", () => {
    for (const tool of SEARCH_TOOLS) {
      expect(isSearchCommand(`hits=$(${tool} pattern .)`)).toBe(true);
    }
  });

  it("detects every search tool inside backtick substitution", () => {
    for (const tool of SEARCH_TOOLS) {
      expect(isSearchCommand(`hits=\`${tool} pattern .\``)).toBe(true);
    }
  });

  it("detects search tools inside a standalone $", () => {
    expect(isSearchCommand("$(grep foo .)")).toBe(true);
    expect(isSearchCommand("$(find . -name x)")).toBe(true);
    expect(isSearchCommand("echo result: $(rg foo src/)")).toBe(true);
  });

  it("detects search inside $ within a pipeline", () => {
    expect(isSearchCommand("hits=$(grep foo . | head -20)")).toBe(true);
    expect(isSearchCommand("n=$(find . -name '*.ts' | wc -l)")).toBe(true);
    expect(isSearchCommand("out=$(rg foo | grep -v bar | head)")).toBe(true);
  });

  it("detects xargs <search> inside $", () => {
    expect(isSearchCommand("out=$(find . | xargs grep foo)")).toBe(true);
    expect(isSearchCommand("m=$(cat list | xargs rg bar)")).toBe(true);
  });

  it("detects sudo <search> inside $", () => {
    expect(isSearchCommand("r=$(sudo grep foo /etc)")).toBe(true);
    expect(isSearchCommand("r=$(sudo find / -name cfg)")).toBe(true);
  });

  it("does NOT flag non-search $ or backtick substitution", () => {
    expect(isSearchCommand("dir=$(pwd)")).toBe(false);
    expect(isSearchCommand("n=$(basename x)")).toBe(false);
    expect(isSearchCommand("v=$(echo hi)")).toBe(false);
    // arithmetic expansion is not a search
    expect(isSearchCommand("x=$((1 + 2))")).toBe(false);
    // backtick non-search
    expect(isSearchCommand("d=`pwd`")).toBe(false);
  });

  it("does NOT false-match a search-tool name quoted inside $", () => {
    // grep is data here (a string argument), not a command
    expect(isSearchCommand('msg=$(echo "run grep now")')).toBe(false);
  });

  it("regression: detects grep inside $ in a for-loop (reported bug)", () => {
    // The exact command that ran 3m10s without a timeout because grep was
    // hidden inside $ inside a for-loop body, invisible to the old
    // (opaque) decomposer.
    const reportedForLoop = `for d in E:/sync/unique/work/git/pi/avtc-pi*/; do
  name=$(basename "$d")
  hits=$(grep -rn "from ['\\"]@earendil-works/pi-ai['\\"]" "$d" --include="*.ts" 2>/dev/null | grep -v node_modules | grep -v "/compat" | grep -v "/base" | head -20)
  if [ -n "$hits" ]; then
    echo "=== $name ==="
    echo "$hits"
  fi
done`;
    expect(isSearchCommand(reportedForLoop)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Timeout resolution — pure helpers
// ---------------------------------------------------------------------------

describe("msToTimeoutSeconds", () => {
  it("converts exact seconds", () => {
    expect(msToTimeoutSeconds(120_000)).toBe(120);
    expect(msToTimeoutSeconds(600_000)).toBe(600);
  });

  it("rounds up so the command is never killed sooner than configured", () => {
    expect(msToTimeoutSeconds(90_500)).toBe(91);
    expect(msToTimeoutSeconds(1_500)).toBe(2);
  });

  it("floors at 1s to avoid an instant-kill 0", () => {
    expect(msToTimeoutSeconds(1)).toBe(1);
    expect(msToTimeoutSeconds(500)).toBe(1);
  });
});

describe("minNullableMs", () => {
  it("returns the smaller finite value", () => {
    expect(minNullableMs(120_000, 600_000)).toBe(120_000);
    expect(minNullableMs(600_000, 120_000)).toBe(120_000);
  });

  it("treats null (Infinite) as larger than any finite value", () => {
    expect(minNullableMs(null, 600_000)).toBe(600_000);
    expect(minNullableMs(600_000, null)).toBe(600_000);
  });

  it("returns null only when both are null", () => {
    expect(minNullableMs(null, null)).toBe(null);
  });
});

describe("resolveBashTimeoutSeconds", () => {
  const SEARCH_CMD = "grep foo src/";
  const NON_SEARCH_CMD = "echo hello";

  it("non-search command uses the bash timeout", () => {
    expect(resolveBashTimeoutSeconds(NON_SEARCH_CMD, 120_000, 600_000)).toBe(600);
  });

  it("search command uses the SHORTER of search and bash timeouts", () => {
    // search (2m) < bash (10m) → search wins
    expect(resolveBashTimeoutSeconds(SEARCH_CMD, 120_000, 600_000)).toBe(120);
    // bash (1m) < search (2m) → bash wins
    expect(resolveBashTimeoutSeconds(SEARCH_CMD, 120_000, 60_000)).toBe(60);
  });

  it("search command equals bash timeout when search is Infinite", () => {
    expect(resolveBashTimeoutSeconds(SEARCH_CMD, null, 600_000)).toBe(600);
  });

  it("non-search command has no timeout when bash is Infinite", () => {
    expect(resolveBashTimeoutSeconds(NON_SEARCH_CMD, 120_000, null)).toBeUndefined();
  });

  it("search command still gets the search timeout when bash is Infinite", () => {
    expect(resolveBashTimeoutSeconds(SEARCH_CMD, 120_000, null)).toBe(120);
  });

  it("returns undefined when no limit applies (both Infinite)", () => {
    expect(resolveBashTimeoutSeconds(SEARCH_CMD, null, null)).toBeUndefined();
    expect(resolveBashTimeoutSeconds(NON_SEARCH_CMD, null, null)).toBeUndefined();
  });
});

describe("hasExplicitTimeout", () => {
  it("true for a positive timeout", () => {
    expect(hasExplicitTimeout({ command: "x", timeout: 10 })).toBe(true);
  });

  it("false when timeout is missing", () => {
    expect(hasExplicitTimeout({ command: "x" })).toBe(false);
  });

  it("false for zero (treated as not set)", () => {
    expect(hasExplicitTimeout({ command: "x", timeout: 0 })).toBe(false);
  });

  it("false for negative (treated as not set)", () => {
    expect(hasExplicitTimeout({ command: "x", timeout: -1 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// registerSearchToolTimeouts — bash timeout injection
// ---------------------------------------------------------------------------

type AnyHandler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown> | unknown;

interface FakePi {
  handlers: Map<string, AnyHandler[]>;
  sent: Array<{ content: string; options?: unknown }>;
  aborted: number;
  notified: Array<{ msg: string; level: string }>;
  api: ExtensionAPI;
  ctx: { abort: () => void; hasUI: boolean; ui: { notify: (m: string, l: string) => void } };
}

interface FakePiOptions {
  /** Simulate a subagent (no UI) — skips the user notify path. */
  hasUI?: boolean;
  /** Make abort throw, to exercise the defensive try/catch. */
  abortThrows?: boolean;
  /** Make sendUserMessage throw, to exercise the defensive try/catch. */
  sendThrows?: boolean;
}

function makeFakePi(options: FakePiOptions): FakePi {
  const hasUI = options.hasUI ?? true;
  const sendThrows = options.sendThrows ?? false;
  const pi: FakePi = {
    handlers: new Map<string, AnyHandler[]>(),
    sent: [],
    aborted: 0,
    notified: [],
    // assigned below
    api: undefined as unknown as ExtensionAPI,
    ctx: undefined as unknown as FakePi["ctx"],
  };
  pi.ctx = {
    // Mutate the shared `pi` object so primitive reads stay live.
    abort: () => {
      if (options.abortThrows) throw new Error("abort failed");
      pi.aborted++;
    },
    hasUI,
    ui: { notify: (msg: string, level: string) => pi.notified.push({ msg, level }) },
  };
  pi.api = {
    on: (event: string, handler: AnyHandler) => {
      const list = pi.handlers.get(event) ?? [];
      list.push(handler);
      pi.handlers.set(event, list);
    },
    sendUserMessage: (content: string, opts?: unknown) => {
      if (sendThrows) throw new Error("send failed");
      pi.sent.push({ content, options: opts });
    },
  } as unknown as ExtensionAPI;
  return pi;
}

/** Emit an event to all registered handlers (resolves any returned promises). */
async function emit(pi: FakePi, event: string, payload: Record<string, unknown>): Promise<void> {
  for (const h of pi.handlers.get(event) ?? []) await h(payload, pi.ctx);
}

describe("registerSearchToolTimeouts — bash timeout injection", () => {
  it("injects the search timeout into a bash search command (shorter than bash)", async () => {
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, makeGetSettings({}));
    const input: ToolInputLike = { command: "grep foo src/" };
    await emit(pi, "tool_call", { toolName: "bash", toolCallId: "t1", input });
    expect(input.timeout).toBe(120); // 2m search < 10m bash
  });

  it("injects the bash timeout into a NON-search bash command", async () => {
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, makeGetSettings({}));
    const input: ToolInputLike = { command: "echo hello" };
    await emit(pi, "tool_call", { toolName: "bash", toolCallId: "t1", input });
    expect(input.timeout).toBe(600); // 10m bash
  });

  it("uses the bash timeout for a search command when bash is the shorter limit", async () => {
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, makeGetSettings({ bashTimeoutMs: 60_000 })); // 1m bash
    const input: ToolInputLike = { command: "grep foo src/" };
    await emit(pi, "tool_call", { toolName: "bash", toolCallId: "t1", input });
    expect(input.timeout).toBe(60); // bash (1m) < search (2m)
  });

  it("respects an explicit model-provided timeout", async () => {
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, makeGetSettings({}));
    const input: ToolInputLike = { command: "grep foo src/", timeout: 30 };
    await emit(pi, "tool_call", { toolName: "bash", toolCallId: "t1", input });
    expect(input.timeout).toBe(30); // not overridden
  });

  it("treats a zero/negative timeout as unset and injects the effective one", async () => {
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, makeGetSettings({}));
    // zero
    const inputZero = { command: "echo hello", timeout: 0 };
    await emit(pi, "tool_call", { toolName: "bash", toolCallId: "tz", input: inputZero });
    expect(inputZero.timeout).toBe(600);
    // negative (at the wiring layer, not just hasExplicitTimeout)
    const inputNeg = { command: "echo hello", timeout: -5 };
    await emit(pi, "tool_call", { toolName: "bash", toolCallId: "tn", input: inputNeg });
    expect(inputNeg.timeout).toBe(600);
  });

  it("injects nothing when the bash timeout is Infinite", async () => {
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, makeGetSettings({ bashTimeoutMs: null }));
    const input: ToolInputLike = { command: "echo hello" };
    await emit(pi, "tool_call", { toolName: "bash", toolCallId: "t1", input });
    expect(input.timeout).toBeUndefined();
  });

  it("still injects the search timeout for a search command when bash is Infinite", async () => {
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, makeGetSettings({ bashTimeoutMs: null }));
    const input: ToolInputLike = { command: "grep foo src/" };
    await emit(pi, "tool_call", { toolName: "bash", toolCallId: "t1", input });
    expect(input.timeout).toBe(120);
  });

  it("injects nothing when both timeouts are Infinite", async () => {
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, makeGetSettings({ searchTimeoutMs: null, bashTimeoutMs: null }));
    const input: ToolInputLike = { command: "grep foo src/" };
    await emit(pi, "tool_call", { toolName: "bash", toolCallId: "t1", input });
    expect(input.timeout).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// registerSearchToolTimeouts — grep/find watchdog
// ---------------------------------------------------------------------------

describe("registerSearchToolTimeouts — grep/find watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not abort when grep finishes before the limit", async () => {
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, makeGetSettings({}));
    await emit(pi, "tool_call", { toolName: "grep", toolCallId: "g1", input: { pattern: "x" } });
    // Finish well before 120s
    vi.advanceTimersByTime(60_000);
    await emit(pi, "tool_execution_end", { toolCallId: "g1", toolName: "grep", isError: false });
    vi.advanceTimersByTime(120_000);
    expect(pi.aborted).toBe(0);
    expect(pi.sent).toHaveLength(0);
  });

  it("aborts and sends a narrowing follow-up when grep overruns", async () => {
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, makeGetSettings({}));
    await emit(pi, "tool_call", { toolName: "grep", toolCallId: "g2", input: { pattern: "x" } });
    vi.advanceTimersByTime(120_000); // overrun
    expect(pi.aborted).toBe(1);
    expect(pi.sent).toHaveLength(1);
    expect(pi.sent[0].content).toContain("grep");
    expect(pi.sent[0].content).toContain("2m"); // human-readable duration
    expect(pi.sent[0].options).toEqual({ deliverAs: "followUp" });
    expect(pi.notified).toHaveLength(0); // under cap → no notify
  });

  it("uses the configured search timeout (not a hardcoded value)", async () => {
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, makeGetSettings({ searchTimeoutMs: 60_000 })); // 1m
    await emit(pi, "tool_call", { toolName: "grep", toolCallId: "g0", input: { pattern: "x" } });
    vi.advanceTimersByTime(60_000); // overrun at 1m
    expect(pi.aborted).toBe(1);
    expect(pi.sent[0].content).toContain("1m");
  });

  it("does NOT arm a watchdog when the search timeout is Infinite", async () => {
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, makeGetSettings({ searchTimeoutMs: null }));
    await emit(pi, "tool_call", { toolName: "grep", toolCallId: "gI", input: { pattern: "x" } });
    vi.advanceTimersByTime(3_600_000); // 1h — would overrun any finite limit
    expect(pi.aborted).toBe(0);
    expect(pi.sent).toHaveLength(0);
  });

  it("tool_execution_end clears the pending timer (no late abort)", async () => {
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, makeGetSettings({}));
    await emit(pi, "tool_call", { toolName: "grep", toolCallId: "g3", input: { pattern: "x" } });
    await emit(pi, "tool_execution_end", { toolCallId: "g3", toolName: "grep", isError: false });
    vi.advanceTimersByTime(200_000);
    expect(pi.aborted).toBe(0);
  });

  it("resets the abort counter after a clean grep result", async () => {
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, makeGetSettings({}));
    // one overrun
    await emit(pi, "tool_call", { toolName: "grep", toolCallId: "a1", input: { pattern: "x" } });
    vi.advanceTimersByTime(120_000);
    expect(pi.aborted).toBe(1);
    expect(pi.sent).toHaveLength(1);
    // a subsequent clean grep resets the counter
    await emit(pi, "tool_execution_end", { toolCallId: "a1", toolName: "grep", isError: false });
    await emit(pi, "tool_call", { toolName: "grep", toolCallId: "a2", input: { pattern: "x" } });
    await emit(pi, "tool_execution_end", { toolCallId: "a2", toolName: "grep", isError: false });
    // another overrun should still be under the cap (counter was reset)
    await emit(pi, "tool_call", { toolName: "grep", toolCallId: "a3", input: { pattern: "x" } });
    vi.advanceTimersByTime(120_000);
    expect(pi.aborted).toBe(2);
    expect(pi.sent).toHaveLength(2);
    expect(pi.notified).toHaveLength(0);
  });

  it("stops auto-continuing and notifies after MAX_SEARCH_ABORTS overruns", async () => {
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, makeGetSettings({}));
    // overrun 1 (under cap → follow-up)
    await emit(pi, "tool_call", { toolName: "find", toolCallId: "f1", input: { pattern: "x" } });
    vi.advanceTimersByTime(120_000);
    expect(pi.sent).toHaveLength(1);
    expect(pi.notified).toHaveLength(0);
    // overrun 2 (under cap → follow-up)
    await emit(pi, "tool_call", { toolName: "find", toolCallId: "f2", input: { pattern: "x" } });
    vi.advanceTimersByTime(120_000);
    expect(pi.sent).toHaveLength(2);
    expect(pi.notified).toHaveLength(0);
    // overrun 3 (over cap → notify, NO follow-up)
    await emit(pi, "tool_call", { toolName: "find", toolCallId: "f3", input: { pattern: "x" } });
    vi.advanceTimersByTime(120_000);
    expect(pi.aborted).toBe(3); // still aborted (kill the hung search)
    expect(pi.sent).toHaveLength(2); // no new follow-up
    expect(pi.notified).toHaveLength(1);
    expect(pi.notified[0].msg).toContain("find");
    expect(pi.notified[0].level).toBe("warning");
  });

  it("turn_end clears all pending timers", async () => {
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, makeGetSettings({}));
    await emit(pi, "tool_call", { toolName: "grep", toolCallId: "t1", input: { pattern: "x" } });
    await emit(pi, "tool_call", { toolName: "find", toolCallId: "t2", input: { pattern: "x" } });
    await emit(pi, "turn_end", {});
    vi.advanceTimersByTime(200_000);
    expect(pi.aborted).toBe(0); // timers cleared → no aborts
  });

  // : subagent path (ctx.hasUI === false) — notify is skipped, abort still fires.
  it("skips the user notify under a subagent (hasUI false) but still aborts", async () => {
    const pi = makeFakePi({ hasUI: false });
    registerSearchToolTimeouts(pi.api, makeGetSettings({}));
    await emit(pi, "tool_call", { toolName: "grep", toolCallId: "s1", input: { pattern: "x" } });
    // overrun 3 times to cross the cap (cap path is the notify site)
    vi.advanceTimersByTime(120_000);
    await emit(pi, "tool_call", { toolName: "grep", toolCallId: "s2", input: { pattern: "x" } });
    vi.advanceTimersByTime(120_000);
    await emit(pi, "tool_call", { toolName: "grep", toolCallId: "s3", input: { pattern: "x" } });
    vi.advanceTimersByTime(120_000);
    expect(pi.aborted).toBe(3); // abort still kills the hung search
    expect(pi.notified).toHaveLength(0); // hasUI false → notify skipped
  });

  // : session_shutdown resets the consecutive-abort counter and clears timers.
  it("session_shutdown resets the abort counter and clears pending timers", async () => {
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, makeGetSettings({}));
    // overrun once
    await emit(pi, "tool_call", { toolName: "grep", toolCallId: "g4a", input: { pattern: "x" } });
    vi.advanceTimersByTime(120_000);
    expect(pi.sent).toHaveLength(1);
    // shutdown mid-session (one pending timer still armed)
    await emit(pi, "tool_call", { toolName: "find", toolCallId: "g4b", input: { pattern: "x" } });
    await emit(pi, "session_shutdown", {});
    vi.advanceTimersByTime(200_000); // pending timer must NOT fire
    expect(pi.aborted).toBe(1);
    // after shutdown, a fresh overrun starts back under the cap (counter reset)
    await emit(pi, "tool_call", { toolName: "grep", toolCallId: "g4c", input: { pattern: "x" } });
    vi.advanceTimersByTime(120_000);
    expect(pi.sent).toHaveLength(2); // still under cap → follow-up (not notify)
    expect(pi.notified).toHaveLength(0);
  });

  // : live-settings contract — mutating settings AFTER registration takes effect.
  it("reflects a settings change made after registration on the next event", async () => {
    const settings = { ...DEFAULT_TEST_SETTINGS }; // mutable live settings
    const getSettings = (): UnstuckSettings => settings;
    const pi = makeFakePi({});
    registerSearchToolTimeouts(pi.api, getSettings);
    // initially 2m search < 10m bash → 120s
    const input1: ToolInputLike = { command: "grep foo src/" };
    await emit(pi, "tool_call", { toolName: "bash", toolCallId: "b1", input: input1 });
    expect(input1.timeout).toBe(120);
    // user lowers the bash timeout to 1m → search command now capped at 60s (shorter wins)
    settings.bashTimeoutMs = 60_000;
    const input2: ToolInputLike = { command: "grep foo src/" };
    await emit(pi, "tool_call", { toolName: "bash", toolCallId: "b2", input: input2 });
    expect(input2.timeout).toBe(60);
  });

  // : defensive try/catch around ctx.abort and sendUserMessage must swallow throws.
  it("swallows a throwing abort without surfacing the error", async () => {
    const pi = makeFakePi({ abortThrows: true });
    registerSearchToolTimeouts(pi.api, makeGetSettings({}));
    await emit(pi, "tool_call", { toolName: "grep", toolCallId: "ta", input: { pattern: "x" } });
    expect(() => vi.advanceTimersByTime(120_000)).not.toThrow();
    // follow-up send still attempted after the failed abort
    expect(pi.sent).toHaveLength(1);
  });

  it("swallows a throwing sendUserMessage without surfacing the error", async () => {
    const pi = makeFakePi({ sendThrows: true });
    registerSearchToolTimeouts(pi.api, makeGetSettings({}));
    await emit(pi, "tool_call", { toolName: "grep", toolCallId: "ts", input: { pattern: "x" } });
    expect(() => vi.advanceTimersByTime(120_000)).not.toThrow();
    expect(pi.aborted).toBe(1); // abort still ran (send throw didn't propagate)
  });
});
