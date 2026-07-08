# avtc-pi-unstuck

Auto-continue on empty model responses + configurable timeouts for bash and search tools

## Features

### Empty Response Auto-Continue

When the model ends a turn without producing a text answer (thinking-only,
tool-only, or completely blank), this extension nudges it to continue:

1. First empty response → sends `continue`
2. Second empty response → sends `please continue`
3. Third empty response → warns the user via UI notification

If the empty response was cut off by the token-length limit, a targeted prompt
is sent instead — asking the model for a shorter, more concise response —
before the escalation above kicks in.

### Tool Timeouts

Stops search and `bash` tools from hanging indefinitely. Two timeouts, edited
via `/unstuck:settings` (powered by
[`avtc-pi-settings-ui`](https://github.com/avtc/avtc-pi-settings-ui)) in
human-readable form (`2m`, `1h`, or `Infinite`):

- **Bash timeout** (default **10m**) — any `bash` command that runs past the
  limit is killed; only the command dies, the agent run continues. A timeout
  the model sets itself is always respected.
- **Search timeout** (default **2m**) — a tighter limit for search tools
  (`grep`/`find`, and search-style bash commands). For `bash` search commands
  only the command is killed; for the `grep`/`find` tools the whole agent run
  is aborted (they can't be stopped mid-command) and the model is told to
  narrow its search. It retries up to twice, then warns you instead.

Compound commands are handled correctly (`cd /src && grep "foo"`,
`ls -R | xargs grep "TODO"`, `(cd /path && find . -name "*.ts")`).

## Installation

```bash
pi install npm:avtc-pi-unstuck
```

## Configuration

Run `/unstuck:settings` in pi to open the settings modal and adjust the timeouts
(values in human-readable duration form):

| Setting          | Default | Description                                                                 |
| ---------------- | ------- | --------------------------------------------------------------------------- |
| `searchTimeoutMs`| `2m`    | Timeout for search tools (`grep`/`find` watchdog + search `bash` commands). |
| `bashTimeoutMs`  | `10m`   | Timeout for any `bash` command.                                              |

Both accept `Infinite` to disable the limit. For a search bash command, the
shorter of the two applies. Settings are persisted to
`~/.pi/agent/avtc-pi-unstuck-settings.json` (global) or `.pi/avtc-pi-unstuck-settings.json`
(project) and survive `/reload` via the `PI_SETTINGS_UNSTUCK` env var.

## Usage

No configuration needed. Both features activate automatically when installed.

> Developed with [Z.ai](https://z.ai/subscribe?ic=N5IV4LLOOV) — get 10% off your subscription via this referral link.

## License

MIT
