import { execa } from 'execa';
import { config } from '../config.js';
import { registerTool } from './registry.js';
import type { ToolResult } from '../agent/types.js';

const HARD_BLOCKED: RegExp[] = [
  /\brm\s+-rf?\s+\/(?:\s|$)/i,
  /\brm\s+-rf?\s+\/\*/i,
  /\bmkfs(\.|\s)/i,
  /\bdd\s+.*\bof=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i,
  />\s*\/dev\/sd[a-z]/i,
];

function checkHardBlocked(cmd: string): string | null {
  for (const re of HARD_BLOCKED) {
    if (re.test(cmd)) return `命中硬黑名单: ${re}`;
  }
  return null;
}

function checkDeniedPath(cmd: string): string | null {
  for (const deny of config.tools.denyPaths) {
    if (cmd.includes(deny)) {
      return `命令引用了禁用路径 (agent 自身密钥 / 系统凭据): ${deny}`;
    }
  }
  return null;
}

registerTool({
  name: 'shell_rw',
  description:
    '执行任意 shell 命令 (含写/修改操作)。每次调用都会请求用户审批。极少数硬危险命令 (rm -rf /, mkfs, dd of=/dev, shutdown/reboot 等) 仍然硬拒。优先用 write_file / edit_file / service_op / git_op, 这是兜底通道。',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '完整 shell 命令' },
      cwd: { type: 'string', description: '可选工作目录' },
      timeout_ms: {
        type: 'integer',
        description: `超时毫秒, 默认 ${config.tools.shellTimeoutMs}, 最大 300000`,
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async confirm(args) {
    const command = String(args.command ?? '');
    const cwd = args.cwd ? String(args.cwd) : '(默认)';
    return {
      summary: `执行写操作 shell: ${command.length > 100 ? `${command.slice(0, 100)}...` : command}`,
      details: `cwd: ${cwd}\n完整命令:\n${command}`,
    };
  },
  async handler(args): Promise<ToolResult> {
    const command = String(args.command ?? '').trim();
    if (!command) return { ok: false, content: '空命令' };

    const blocked = checkHardBlocked(command);
    if (blocked) return { ok: false, content: `拒绝执行: ${blocked}` };

    const denied = checkDeniedPath(command);
    if (denied) return { ok: false, content: `拒绝执行: ${denied}` };

    const timeoutMs = Math.min(
      Math.max(Number(args.timeout_ms) || config.tools.shellTimeoutMs, 1_000),
      300_000,
    );

    try {
      const proc = await execa(command, {
        shell: true,
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
        forceKillAfterDelay: config.tools.shellKillGraceMs,
        ...(typeof args.cwd === 'string' && args.cwd ? { cwd: args.cwd } : {}),
        reject: false,
        all: true,
        stripFinalNewline: false,
      });
      const out = proc.all ?? `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
      const status = proc.failed
        ? `exit=${proc.exitCode ?? 'n/a'}${proc.timedOut ? ' (超时)' : ''}`
        : 'exit=0';
      return {
        ok: !proc.failed,
        content: `$ ${command}\n[${status}]\n${out}`,
      };
    } catch (err) {
      return { ok: false, content: `执行错误: ${(err as Error).message}` };
    }
  },
});
