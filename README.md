# AI Ops Agent

OpenRouter-backed ops agent with Telegram bot adapter (planned) and CLI for ad-hoc server operations on Linux / 宝塔 environments.

## Status

| Phase | Module | State |
| --- | --- | --- |
| P0 | Project skeleton, config, db, logger | done |
| P1 | Agent loop, OpenRouter client, 2 read-only tools, CLI | done |
| P2 | Telegram bot with allow-list + inline confirmation | todo |
| P3 | Filesystem, git, service, log-tail tools | todo |
| P4 | Permission policy + write tool approval | todo |
| P5 | 宝塔 panel API client | todo |
| P6 | Cron watchdog + proactive alerts | todo |
| P7 | systemd / PM2 deploy scripts | todo |

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
- `ALLOWED_PATHS` — comma-separated absolute paths the filesystem tools may touch.
- `READONLY_PATHS` — paths that are read-only even inside `ALLOWED_PATHS`.
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
- Every tool call is recorded in `audit_log`.
- Write/mutate tools are deferred to P3+P4 so the loop cannot mutate the system yet.
