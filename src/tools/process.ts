import fs from 'node:fs';
import { execa } from 'execa';
import { config } from '../config.js';
import { registerTool } from './registry.js';
import type { ToolResult } from '../agent/types.js';

const ALLOWED_SIGNALS = new Set(['TERM', 'INT', 'HUP', 'QUIT', 'KILL', 'USR1', 'USR2']);
const MIN_KILLABLE_PID = 100;

interface ProcInfo {
  pid: number;
  comm: string;
  cmdline: string;
  uid: number;
  state: string;
}

function readProc(pid: number): ProcInfo | null {
  try {
    const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
    const cmdRaw = fs.readFileSync(`/proc/${pid}/cmdline`);
    const cmdline = cmdRaw.toString('utf-8').replace(/\0/g, ' ').trim();
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
    const uidMatch = status.match(/^Uid:\s+(\d+)/m);
    const stateMatch = status.match(/^State:\s+(\S)/m);
    return {
      pid,
      comm,
      cmdline,
      uid: uidMatch ? Number(uidMatch[1]) : -1,
      state: stateMatch?.[1] ?? '?',
    };
  } catch {
    return null;
  }
}

function isProtected(info: ProcInfo): string | null {
  const protectedNames = config.processKill.protectedNames;
  for (const name of protectedNames) {
    if (!name) continue;
    if (info.comm === name) return name;
    if (info.comm.startsWith(`${name}-`) || info.comm.startsWith(`${name}.`)) return name;
    if (info.cmdline.includes(`/${name}`)) return name;
  }
  return null;
}

function sudoPrefix(): string[] {
  return config.tools.useSudo ? ['sudo', '-n'] : [];
}

registerTool({
  name: 'process_kill',
  description:
    '按 pid 发送信号杀进程. 严格安全闸: pid<=100 拒, 自身 pid 拒, 进程名命中 PROCESS_KILL_PROTECTED 拒 (含 sshd/systemd/mysqld/BT-Panel 等). 默认 SIGTERM. SIGKILL 需显式 force=true. 走审批.',
  parameters: {
    type: 'object',
    properties: {
      pid: { type: 'integer', description: '目标进程 pid' },
      signal: {
        type: 'string',
        enum: ['TERM', 'INT', 'HUP', 'QUIT', 'KILL', 'USR1', 'USR2'],
        description: '默认 TERM',
      },
      force: { type: 'boolean', description: 'true 才允许 SIGKILL (相当于显式 -9)' },
    },
    required: ['pid'],
    additionalProperties: false,
  },
  dangerous: true,
  confirm(args) {
    const pid = Number(args.pid);
    const info = Number.isInteger(pid) ? readProc(pid) : null;
    const sig = args.signal === 'KILL' && args.force === true ? 'KILL' : args.signal ?? 'TERM';
    const desc = info ? `${info.comm} (${info.cmdline.slice(0, 80)})` : '<pid not found>';
    return {
      summary: `kill -${sig} ${pid} → ${desc}`,
      details: JSON.stringify({ pid, signal: sig, ...info }, null, 2),
    };
  },
  async handler(args): Promise<ToolResult> {
    const pid = Number(args.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return { ok: false, content: 'pid 必须为正整数' };
    }
    if (pid <= MIN_KILLABLE_PID) {
      return { ok: false, content: `pid ${pid} <= ${MIN_KILLABLE_PID}, 拒杀 (内核/系统服务范围)` };
    }
    if (pid === process.pid) {
      return { ok: false, content: '拒杀: 这是 agent 自己的 pid' };
    }
    const info = readProc(pid);
    if (!info) {
      return { ok: false, content: `pid ${pid} 不存在或无法读取 /proc/${pid}` };
    }
    const hit = isProtected(info);
    if (hit) {
      return {
        ok: false,
        content: `拒杀: 进程名 ${info.comm} 命中 PROCESS_KILL_PROTECTED (${hit}). cmdline: ${info.cmdline.slice(0, 200)}`,
      };
    }
    const sigArg = typeof args.signal === 'string' ? args.signal.toUpperCase() : 'TERM';
    if (!ALLOWED_SIGNALS.has(sigArg)) {
      return { ok: false, content: `不支持的 signal: ${sigArg}` };
    }
    if (sigArg === 'KILL' && args.force !== true) {
      return { ok: false, content: 'SIGKILL 需 force=true (危险, 进程无机会清理)' };
    }
    try {
      const proc = await execa('kill', [`-${sigArg}`, String(pid)], {
        reject: false,
        all: true,
        timeout: 5_000,
      });
      if (proc.failed && info.uid === 0 && process.getuid?.() !== 0 && config.tools.useSudo) {
        // 重试 sudo
        const retry = await execa(sudoPrefix()[0]!, [...sudoPrefix().slice(1), 'kill', `-${sigArg}`, String(pid)], {
          reject: false,
          all: true,
          timeout: 5_000,
        });
        if (retry.failed) {
          return {
            ok: false,
            content: `kill 失败 (sudo retry exit=${retry.exitCode}): ${retry.all ?? retry.stderr}`,
          };
        }
        return {
          ok: true,
          content: `[sudo] kill -${sigArg} ${pid} (${info.comm}) 完成`,
        };
      }
      if (proc.failed) {
        return {
          ok: false,
          content: `kill 失败 exit=${proc.exitCode}: ${proc.all ?? proc.stderr}`,
        };
      }
      return {
        ok: true,
        content: `kill -${sigArg} ${pid} (${info.comm}) 完成`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `kill 异常: ${msg}` };
    }
  },
});
