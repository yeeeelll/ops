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
| P5 | 宝塔 panel API client (bt_sites_list / bt_site_op / bt_db_list / bt_db_backup / bt_file_op / bt_ssl_check / bt_cron / bt_logs_recent) | done |
| P6 | Cron watchdog + proactive alerts | todo |
| P7 | systemd unit + install/update scripts | done |
| P10 | 内置工具补全 (cert_check / http_probe / firewall_status / firewall_op / backup_create / process_kill) | done |

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
- `BT_PANEL_URL` + `BT_API_KEY` — required for `bt_*` tools (宝塔面板 API). 留空则全部 `bt_*` 工具返回 "未配置" 错误。`BT_TLS_INSECURE=true` 跳过自签证书校验。

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
- `bt_file_op` paths are checked against `DENY_PATHS` (same blocklist as `read_file` / `write_file`), so the agent cannot use the panel API to read `.env`, `/etc/shadow`, etc.

## 宝塔工具 (P5)

| Tool | Action | Approval |
| --- | --- | --- |
| `bt_sites_list` | 列站点 (domain/PHP/状态/到期) | no |
| `bt_site_op` | start / stop / set_php | yes |
| `bt_db_list` | 列数据库 | no |
| `bt_db_backup` | 触发面板备份 | yes |
| `bt_file_op` | read / write / mkdir (受 DENY_PATHS 限制) | yes |
| `bt_ssl_check` | 查 SSL 有效期 (单站点或全部) | no |
| `bt_cron` | list / add_daily_shell / delete | yes |
| `bt_ssl_renew` | LE 证书续签 / 覆盖申请 (单/多域名) | yes |
| `bt_logs_recent` | tail access / error / php_slow / php_error 日志 | no |
| `bt_waf_status` | 免费 WAF (btwaf) 总开关 + 规则 + 永久封禁 IP + 站点级覆盖 | no |
| `bt_waf_block_ip` | 加 IP 到 `drop_ip.json` + reload nginx | yes |
| `bt_waf_unblock_ip` | 移除 IP + reload nginx | yes |
| `bt_waf_logs` | tail `total_logs/<date>/<site>.log` 拦截日志 | no |
| `bt_waf_rule_toggle` | 切 sql/xss/cc/scan/... 规则 + reload nginx | yes |

需在 `.env` 配置 `BT_PANEL_URL` + `BT_API_KEY` (面板 → 设置 → API 接口, 并把本机 IP 加入白名单)。鉴权用 `md5(time + md5(api_key))`, 无第三方依赖。

## 运维工具 (P10)

| Tool | 作用 | Approval |
| --- | --- | --- |
| `cert_check` | 任意 host:port TLS 证书 (剩余天数/issuer/SAN/链长度) | no |
| `http_probe` | GET/HEAD 任意 URL, 返 status + headers + body 前 N 字 | no |
| `firewall_status` | ufw 规则 (含编号) + fail2ban jails / banned IP | no |
| `firewall_op` | ufw allow/deny/delete + fail2ban unban/ban/reload | yes |
| `backup_create` | tar.gz 业务目录 + 可选 db dump → BACKUP_DIR | yes |
| `process_kill` | 按 pid 杀进程 (PROCESS_KILL_PROTECTED 兜底, 拒 pid<=100, 拒自身) | yes |

环境变量在 `.env.example` 的 "P10 运维工具" 段。`firewall_*` / `process_kill` 需要 sudo 白名单 (`/etc/sudoers.d/ai-agent` 加 `ufw`, `fail2ban-client`, `kill`)。`backup_create` paths 仍受 `ALLOWED_PATHS` + `DENY_PATHS` 沙盒约束。`process_kill` 永远拒杀 `PROCESS_KILL_PROTECTED` 命中的进程名 (含 `BT-Panel` / `sshd` / `mysqld` / 本进程自身)。
