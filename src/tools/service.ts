import { execa } from 'execa';
import { config } from '../config.js';
import { registerTool } from './registry.js';
import type { ToolResult } from '../agent/types.js';

const ALLOWED_ACTIONS = new Set(['restart', 'reload', 'start', 'stop']);

function unitAllowed(unit: string): boolean {
  const list = config.tools.approvedServices;
  if (list.length === 0) return false;
  if (list.includes(unit)) return true;
  return list.some((pattern) => {
    if (pattern.endsWith('*')) {
      return unit.startsWith(pattern.slice(0, -1));
    }
    return false;
  });
}

registerTool({
  name: 'service_op',
  description:
    '对 systemd 服务执行 start/stop/restart/reload。只接受 APPROVED_SERVICES 白名单中的 unit 名称 (支持前缀通配 nginx*)。每次调用都会请求用户审批。',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      unit: {
        type: 'string',
        description: 'systemd unit 名 (例 nginx.service / php-fpm)',
      },
      action: {
        type: 'string',
        enum: ['restart', 'reload', 'start', 'stop'],
        description: '操作类型',
      },
    },
    required: ['unit', 'action'],
    additionalProperties: false,
  },
  async confirm(args) {
    const unit = String(args.unit ?? '');
    const action = String(args.action ?? '');
    return {
      summary: `systemctl ${action} ${unit}`,
      details: `unit: ${unit}\naction: ${action}\n白名单: ${config.tools.approvedServices.join(', ') || '(空)'}`,
    };
  },
  async handler(args): Promise<ToolResult> {
    const unit = String(args.unit ?? '').trim();
    const action = String(args.action ?? '').trim();
    if (!unit) return { ok: false, content: '缺少 unit' };
    if (!ALLOWED_ACTIONS.has(action)) return { ok: false, content: `非法 action: ${action}` };
    if (!unitAllowed(unit)) {
      return {
        ok: false,
        content: `unit "${unit}" 不在 APPROVED_SERVICES 白名单内, 拒绝执行`,
      };
    }
    if (/[;&|<>$`\\]/.test(unit)) {
      return { ok: false, content: 'unit 名含非法字符' };
    }

    try {
      const proc = await execa('systemctl', [action, unit], {
        timeout: 30_000,
        reject: false,
        all: true,
        stripFinalNewline: false,
      });
      const out = proc.all ?? `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
      return {
        ok: !proc.failed,
        content: `$ systemctl ${action} ${unit}\n[exit=${proc.exitCode ?? 'n/a'}]\n${out || '(无输出)'}`,
      };
    } catch (err) {
      return { ok: false, content: `执行失败: ${(err as Error).message}` };
    }
  },
});
