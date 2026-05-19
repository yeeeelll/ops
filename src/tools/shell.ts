import { execa } from 'execa';
import { config } from '../config.js';
import { registerTool } from './registry.js';
import type { ToolResult } from '../agent/types.js';

const DANGEROUS_PATTERNS: RegExp[] = [
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

const READ_ONLY_BINARIES = new Set([
  'ls', 'cat', 'tail', 'head', 'grep', 'awk', 'sed', 'wc', 'find', 'tree',
  'ps', 'top', 'htop', 'free', 'df', 'du', 'uptime', 'who', 'w',
  'date', 'whoami', 'hostname', 'uname', 'pwd', 'echo', 'env', 'printenv',
  'stat', 'file', 'readlink', 'realpath',
  'systemctl', 'journalctl', 'docker', 'git', 'curl', 'wget',
  'netstat', 'ss', 'ip', 'dig', 'nslookup', 'ping', 'traceroute',
]);

function firstWord(cmd: string): string {
  const m = cmd.trim().match(/^([^\s|;&<>()]+)/);
  return m?.[1] ?? '';
}

function checkDangerous(cmd: string): string | null {
  for (const re of DANGEROUS_PATTERNS) {
    if (re.test(cmd)) return `dangerous pattern matched: ${re}`;
  }
  return null;
}

function isLikelyReadOnly(cmd: string): boolean {
  const head = firstWord(cmd);
  if (!head) return false;
  const base = head.split('/').pop() ?? '';
  if (!READ_ONLY_BINARIES.has(base)) return false;

  if (base === 'systemctl') {
    return /^\s*systemctl\s+(status|is-active|is-enabled|show|list-units|list-unit-files|cat)\b/.test(cmd);
  }
  if (base === 'journalctl') {
    return !/\b(--rotate|--vacuum|--flush)\b/.test(cmd);
  }
  if (base === 'docker') {
    return /^\s*docker\s+(ps|images|inspect|logs|stats|info|version|history|top)\b/.test(cmd);
  }
  if (base === 'git') {
    return /^\s*git\s+(status|log|diff|show|rev-parse|branch|remote\s+-v|config\s+--get)\b/.test(cmd);
  }
  return true;
}

registerTool({
  name: 'shell_ro',
  description:
    'Run a single read-only shell command on the server. Use for inspection only ' +
    '(ls, cat, tail, grep, ps, df, systemctl status, journalctl, docker ps, git status, etc). ' +
    'Mutating commands are rejected.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute. Single command, no destructive operations.',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory. Must be inside ALLOWED_PATHS.',
      },
      timeout_ms: {
        type: 'integer',
        description: `Optional timeout in ms. Defaults to ${config.tools.shellTimeoutMs}, max 120000.`,
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async handler(args): Promise<ToolResult> {
    const command = String(args.command ?? '').trim();
    if (!command) return { ok: false, content: 'empty command' };

    const danger = checkDangerous(command);
    if (danger) return { ok: false, content: `rejected: ${danger}` };

    if (!isLikelyReadOnly(command)) {
      return {
        ok: false,
        content:
          `rejected: command head "${firstWord(command)}" is not on the read-only whitelist. ` +
          'Use shell_ro only for inspection. Mutating ops require a separate tool with approval.',
      };
    }

    const timeoutMs = Math.min(
      Math.max(Number(args.timeout_ms) || config.tools.shellTimeoutMs, 1_000),
      120_000,
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
        ? `exit=${proc.exitCode ?? 'n/a'}${proc.timedOut ? ' (timed out)' : ''}`
        : `exit=0`;
      return {
        ok: !proc.failed,
        content: `$ ${command}\n[${status}]\n${out}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `execution error: ${msg}` };
    }
  },
});
