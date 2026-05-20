import path from 'node:path';
import { execa } from 'execa';
import { config } from '../config.js';
import { registerTool } from './registry.js';
import type { ToolResult } from '../agent/types.js';

type GitAction = 'pull' | 'fetch' | 'add' | 'commit' | 'push' | 'checkout' | 'reset';

const ALLOWED_ACTIONS = new Set<GitAction>(['pull', 'fetch', 'add', 'commit', 'push', 'checkout', 'reset']);

function repoAllowed(repo: string): boolean {
  const list = config.tools.approvedGitRepos;
  if (list.length === 0) return false;
  const resolved = path.resolve(repo);
  return list.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function buildArgs(action: GitAction, args: Record<string, unknown>): { argv: string[] | null; error?: string } {
  switch (action) {
    case 'pull':
      return { argv: ['pull', '--ff-only'] };
    case 'fetch':
      return { argv: ['fetch', '--prune'] };
    case 'add': {
      const paths = Array.isArray(args.paths) ? args.paths : args.path ? [args.path] : ['.'];
      const flat = paths.map((p) => String(p)).filter(Boolean);
      if (flat.some((p) => p.startsWith('-'))) return { argv: null, error: 'paths 含非法前缀 -' };
      return { argv: ['add', '--', ...flat] };
    }
    case 'commit': {
      const message = String(args.message ?? '');
      if (!message.trim()) return { argv: null, error: '缺少 commit message' };
      return { argv: ['commit', '-m', message] };
    }
    case 'push':
      return { argv: ['push'] };
    case 'checkout': {
      const ref = String(args.ref ?? '');
      if (!ref || ref.startsWith('-')) return { argv: null, error: '非法 ref' };
      return { argv: ['checkout', '--', ref] };
    }
    case 'reset': {
      const target = String(args.target ?? '');
      if (target && target !== '--hard' && target !== '--soft' && target !== '--mixed') {
        return { argv: null, error: 'reset target 仅允许 --hard/--soft/--mixed' };
      }
      const ref = args.ref ? String(args.ref) : 'HEAD';
      if (ref.startsWith('-')) return { argv: null, error: '非法 ref' };
      return { argv: ['reset', ...(target ? [target] : []), ref] };
    }
    default:
      return { argv: null, error: `未支持的 action: ${action}` };
  }
}

registerTool({
  name: 'git_op',
  description:
    '在 APPROVED_GIT_REPOS 内的 Git 仓库执行写操作: pull/fetch/add/commit/push/checkout/reset。每次调用都会请求用户审批。',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: '仓库根目录绝对路径' },
      action: {
        type: 'string',
        enum: ['pull', 'fetch', 'add', 'commit', 'push', 'checkout', 'reset'],
        description: 'Git 操作',
      },
      message: { type: 'string', description: 'commit 时的提交信息' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'add 时的文件路径列表',
      },
      ref: { type: 'string', description: 'checkout/reset 的引用 (分支/commit/HEAD)' },
      target: {
        type: 'string',
        enum: ['--hard', '--soft', '--mixed'],
        description: 'reset 模式',
      },
    },
    required: ['repo', 'action'],
    additionalProperties: false,
  },
  async confirm(args) {
    const action = String(args.action ?? '');
    const repo = String(args.repo ?? '');
    const built = buildArgs(action as GitAction, args);
    return {
      summary: `git ${action} 于 ${repo}`,
      details: `仓库: ${repo}\n命令: git ${(built.argv ?? []).join(' ')}\n额外参数: ${JSON.stringify(args)}`,
    };
  },
  async handler(args): Promise<ToolResult> {
    const repo = String(args.repo ?? '');
    const action = String(args.action ?? '') as GitAction;
    if (!repo) return { ok: false, content: '缺少 repo' };
    if (!ALLOWED_ACTIONS.has(action)) return { ok: false, content: `非法 action: ${action}` };
    if (!repoAllowed(repo)) {
      return { ok: false, content: `repo "${repo}" 不在 APPROVED_GIT_REPOS 白名单内` };
    }
    const built = buildArgs(action, args);
    if (!built.argv) return { ok: false, content: built.error ?? '参数错误' };

    try {
      const proc = await execa('git', built.argv, {
        cwd: path.resolve(repo),
        timeout: 60_000,
        reject: false,
        all: true,
        stripFinalNewline: false,
      });
      const out = proc.all ?? `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
      return {
        ok: !proc.failed,
        content: `$ git ${built.argv.join(' ')}\n[exit=${proc.exitCode ?? 'n/a'}]\n${out || '(无输出)'}`,
      };
    } catch (err) {
      return { ok: false, content: `执行失败: ${(err as Error).message}` };
    }
  },
});
