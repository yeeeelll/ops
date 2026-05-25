import { execa } from 'execa';
import net from 'node:net';
import { config } from '../config.js';
import { registerTool } from './registry.js';
import type { ToolResult } from '../agent/types.js';

const JAIL_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const UFW_PROTO = new Set(['tcp', 'udp', 'any']);

function sudoPrefix(): string[] {
  return config.tools.useSudo ? ['sudo', '-n'] : [];
}

function validIp(ip: string): boolean {
  return net.isIP(ip) > 0;
}

async function exec(cmd: string[]): Promise<{ ok: boolean; output: string; exit: number }> {
  if (cmd.length === 0) return { ok: false, output: 'empty command', exit: -1 };
  try {
    const proc = await execa(cmd[0]!, cmd.slice(1), {
      reject: false,
      all: true,
      timeout: 30_000,
      stripFinalNewline: false,
    });
    return {
      ok: !proc.failed,
      output: proc.all ?? `${proc.stdout ?? ''}${proc.stderr ?? ''}`,
      exit: proc.exitCode ?? -1,
    };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err), exit: -1 };
  }
}

registerTool({
  name: 'firewall_status',
  description:
    '查 ufw 规则 (含编号) + fail2ban jails / banned IP. target: ufw | fail2ban | all (默认 all). 只读, 无审批.',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', enum: ['ufw', 'fail2ban', 'all'] },
    },
    additionalProperties: false,
  },
  async handler(args): Promise<ToolResult> {
    const target = String(args.target ?? 'all');
    const out: string[] = [];
    if (target === 'ufw' || target === 'all') {
      const r = await exec([...sudoPrefix(), 'ufw', 'status', 'numbered']);
      out.push(`# ufw status numbered (exit=${r.exit})\n${r.output}`);
    }
    if (target === 'fail2ban' || target === 'all') {
      const r = await exec([...sudoPrefix(), 'fail2ban-client', 'status']);
      out.push(`# fail2ban-client status (exit=${r.exit})\n${r.output}`);
      if (r.ok) {
        const m = r.output.match(/Jail list:\s+(.+)/);
        const jails = (m?.[1] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => JAIL_NAME_RE.test(s));
        for (const j of jails) {
          const jr = await exec([...sudoPrefix(), 'fail2ban-client', 'status', j]);
          out.push(`# fail2ban-client status ${j} (exit=${jr.exit})\n${jr.output}`);
        }
      }
    }
    return { ok: true, content: out.join('\n\n') };
  },
});

registerTool({
  name: 'firewall_op',
  description:
    '修改防火墙规则. action: ufw_allow | ufw_deny | ufw_delete | f2b_unban | f2b_ban | f2b_reload. 走审批. ' +
    'ufw_allow/deny target 形如 "22" / "80/tcp" / "from 1.2.3.4" / "from 1.2.3.4 to any port 22". ' +
    'ufw_delete target 为规则号 (firewall_status 输出的编号).',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['ufw_allow', 'ufw_deny', 'ufw_delete', 'f2b_unban', 'f2b_ban', 'f2b_reload'],
      },
      target: { type: 'string', description: 'ufw 操作的目标 (port/proto/ip/规则号)' },
      ip: { type: 'string', description: 'f2b_unban / f2b_ban 的 IP' },
      jail: { type: 'string', description: 'f2b_ban 的 jail 名, 默认 sshd' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  dangerous: true,
  confirm(args) {
    const a = String(args.action ?? '');
    const tgt = args.target ?? args.ip ?? args.jail ?? '?';
    return { summary: `firewall ${a} ${tgt}`, details: JSON.stringify(args, null, 2) };
  },
  async handler(args): Promise<ToolResult> {
    const action = String(args.action ?? '');
    const target = typeof args.target === 'string' ? args.target.trim() : '';
    const ip = typeof args.ip === 'string' ? args.ip.trim() : '';
    const jail = typeof args.jail === 'string' ? args.jail.trim() : '';

    switch (action) {
      case 'ufw_allow':
      case 'ufw_deny': {
        if (!target) return { ok: false, content: 'target required' };
        if (target.includes('/')) {
          const proto = target.split('/')[1]?.toLowerCase() ?? '';
          if (!UFW_PROTO.has(proto)) return { ok: false, content: `bad proto: ${proto}` };
        }
        const verb = action === 'ufw_allow' ? 'allow' : 'deny';
        const parts = target.split(/\s+/).filter(Boolean);
        const r = await exec([...sudoPrefix(), 'ufw', verb, ...parts]);
        return { ok: r.ok, content: `# ufw ${verb} ${target} (exit=${r.exit})\n${r.output}` };
      }
      case 'ufw_delete': {
        const n = Number(target);
        if (!Number.isInteger(n) || n <= 0) {
          return { ok: false, content: 'target must be positive rule number (查 firewall_status)' };
        }
        const r = await exec([...sudoPrefix(), 'ufw', '--force', 'delete', String(n)]);
        return { ok: r.ok, content: `# ufw --force delete ${n} (exit=${r.exit})\n${r.output}` };
      }
      case 'f2b_unban': {
        if (!ip || !validIp(ip)) return { ok: false, content: 'invalid ip' };
        const r = await exec([...sudoPrefix(), 'fail2ban-client', 'unban', ip]);
        return { ok: r.ok, content: `# fail2ban-client unban ${ip} (exit=${r.exit})\n${r.output}` };
      }
      case 'f2b_ban': {
        if (!ip || !validIp(ip)) return { ok: false, content: 'invalid ip' };
        const j = jail || 'sshd';
        if (!JAIL_NAME_RE.test(j)) return { ok: false, content: `invalid jail: ${j}` };
        const r = await exec([...sudoPrefix(), 'fail2ban-client', 'set', j, 'banip', ip]);
        return {
          ok: r.ok,
          content: `# fail2ban-client set ${j} banip ${ip} (exit=${r.exit})\n${r.output}`,
        };
      }
      case 'f2b_reload': {
        const r = await exec([...sudoPrefix(), 'fail2ban-client', 'reload']);
        return { ok: r.ok, content: `# fail2ban-client reload (exit=${r.exit})\n${r.output}` };
      }
      default:
        return { ok: false, content: `unknown action: ${action}` };
    }
  },
});
