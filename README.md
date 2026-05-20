# AI Ops Agent

OpenRouter-backed ops agent with Telegram bot adapter (planned) and CLI for ad-hoc server operations on Linux / 宝塔 environments.

## Status

| Phase | Module | State |
| --- | --- | --- |
| P0 | Project skeleton, config, db, logger | done |
| P1 | Agent loop, OpenRouter client, 2 read-only tools, CLI | done |
| P2 | Telegram bot with allow-list + pseudo streaming | done |
| P3 | write_file / edit_file / service_op / git_op / shell_rw | done |
| P4 | Approval layer (CLI stdin + Telegram inline button + audit) | done |
| P5 | 宝塔 panel API client | todo |
| P6 | Cron watchdog + proactive alerts | todo |
| P7 | systemd unit + install/update scripts | done |

## Quick start

```bash
# Node 20+ required
npm install
cp .env.example .env
# Edit .env: set OPENROUTER_API_KEY, ALLOWED_PATHS
npm run cli
```

CLI commands:

- `:q` quit
- `:new` start a fresh session

## Configuration

All knobs live in `.env`. See `.env.example` for the full list. Critical entries:

- `OPENROUTER_API_KEY` — required.
- `LLM_MODEL` — defaults to `deepseek/deepseek-chat-v3.1`. Switch to any OpenRouter model id.
- `ALLOWED_PATHS` — comma-separated absolute paths that filesystem tools may READ.
- `READONLY_PATHS` — paths that are read-only even inside `ALLOWED_PATHS`.
- `WRITABLE_PATHS` — paths `write_file` / `edit_file` may MUTATE. Empty = no writes.
- `APPROVED_SERVICES` — systemd units `service_op` may start/stop/restart/reload. Supports prefix `nginx*`.
- `APPROVED_GIT_REPOS` — repo roots `git_op` may operate within.
- `APPROVAL_TIMEOUT_MS` — how long to wait for user approval before auto-denying (default 60000).
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_USER_IDS` — required for bot mode.

## Architecture

```
src/
  agent/          # LLM client, tool-call loop, context manager, prompts
  tools/          # Tool registry + individual tools (shell_ro, read_file, ...)
  store/          # SQLite tables: sessions, messages, audit_log
  adapters/       # (planned) Telegram bot + CLI
  config.ts       # zod-validated env config
  logger.ts       # pino logger
  cli.ts          # CLI entry
  bot.ts          # Telegram bot entry (placeholder)
```

Reference: this loop mirrors Claude Code's agent loop — LLM call → tool dispatch → tool results → repeat until no tool calls, with a token-budget trimmer and persistent SQLite session.

## Safety defaults

- Only tools registered in the registry are callable.
- `shell_ro` rejects any command not on a read-only allow-list and pattern-matches against destructive forms.
- `read_file` is sandboxed to `ALLOWED_PATHS`.
- Every tool call (including denials and approval timeouts) is recorded in `audit_log` with the approval decision.
- Write tools (`write_file`, `edit_file`, `service_op`, `git_op`, `shell_rw`) are flagged `dangerous: true` and ALWAYS request user approval through the originating channel (CLI stdin or Telegram inline button) before executing. The approval times out after `APPROVAL_TIMEOUT_MS`.
- `shell_rw` keeps a hard blocklist (`rm -rf /`, `mkfs`, `dd of=/dev/...`, `shutdown`, fork bomb, etc.) that cannot be approved.
