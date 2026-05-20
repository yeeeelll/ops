import fs from 'node:fs/promises';
import path from 'node:path';
import { registerTool } from './registry.js';
import { checkPath } from './paths.js';
import type { ToolResult } from '../agent/types.js';

const MAX_CONTENT_BYTES = 200_000;

function summarizePreview(text: string, max = 600): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (省略 ${text.length - max} 字符)`;
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

registerTool({
  name: 'write_file',
  description:
    '写入或覆盖整个文本文件。必须在 WRITABLE_PATHS 之内, 且不在 READONLY_PATHS 之中。每次调用都会请求用户审批。建议优先使用 edit_file 做小范围修改。',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件绝对路径' },
      content: { type: 'string', description: '完整新文件内容 (UTF-8)' },
      create_dirs: {
        type: 'boolean',
        description: '父目录不存在时是否自动创建 (默认 true)',
      },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async confirm(args) {
    const target = String(args.path ?? '');
    const content = String(args.content ?? '');
    let exists = '';
    try {
      const st = await fs.stat(target);
      exists = st.isFile() ? `(已存在, 当前 ${st.size} 字节)` : '(目标不是普通文件)';
    } catch {
      exists = '(新文件)';
    }
    return {
      summary: `写入文件 ${target} ${exists}, 新内容 ${content.length} 字符`,
      details: `路径: ${target}\n新内容预览:\n${summarizePreview(content)}`,
    };
  },
  async handler(args): Promise<ToolResult> {
    const target = String(args.path ?? '');
    const content = String(args.content ?? '');
    const createDirs = args.create_dirs !== false;
    if (!target) return { ok: false, content: '缺少 path' };
    const check = checkPath(target, true);
    if (!check.ok) return { ok: false, content: check.reason ?? '路径被拒' };
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
      return {
        ok: false,
        content: `内容超出 ${MAX_CONTENT_BYTES} 字节上限, 建议拆分或用 edit_file`,
      };
    }
    try {
      if (createDirs) await ensureParentDir(check.resolved);
      await fs.writeFile(check.resolved, content, 'utf8');
      const st = await fs.stat(check.resolved);
      return {
        ok: true,
        content: `已写入 ${check.resolved} (${st.size} 字节)`,
      };
    } catch (err) {
      return { ok: false, content: `写入失败: ${(err as Error).message}` };
    }
  },
});

registerTool({
  name: 'edit_file',
  description:
    '通过精确字符串替换修改已存在的文件。old_string 必须在文件中唯一出现一次, 用 new_string 替换。必须在 WRITABLE_PATHS 之内。每次调用都会请求用户审批。',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件绝对路径' },
      old_string: { type: 'string', description: '待替换的精确文本 (必须唯一)' },
      new_string: { type: 'string', description: '替换为的新文本' },
      replace_all: {
        type: 'boolean',
        description: '设为 true 时允许多处匹配并全部替换 (默认 false)',
      },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  async confirm(args) {
    const target = String(args.path ?? '');
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');
    const replaceAll = args.replace_all === true;
    return {
      summary: `编辑文件 ${target} ${replaceAll ? '(全部匹配)' : '(精确单点)'}`,
      details: `路径: ${target}\n替换前:\n${summarizePreview(oldStr, 400)}\n\n替换后:\n${summarizePreview(newStr, 400)}`,
    };
  },
  async handler(args): Promise<ToolResult> {
    const target = String(args.path ?? '');
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');
    const replaceAll = args.replace_all === true;

    if (!target) return { ok: false, content: '缺少 path' };
    if (!oldStr) return { ok: false, content: '缺少 old_string' };

    const check = checkPath(target, true);
    if (!check.ok) return { ok: false, content: check.reason ?? '路径被拒' };

    let original: string;
    try {
      original = await fs.readFile(check.resolved, 'utf8');
    } catch (err) {
      return { ok: false, content: `读取失败: ${(err as Error).message}` };
    }

    const occurrences = countOccurrences(original, oldStr);
    if (occurrences === 0) {
      return { ok: false, content: '在文件中找不到 old_string, 不做修改' };
    }
    if (!replaceAll && occurrences > 1) {
      return {
        ok: false,
        content: `old_string 在文件中出现 ${occurrences} 次, 不唯一。请扩大上下文使其唯一, 或显式 replace_all=true`,
      };
    }

    const updated = replaceAll ? original.split(oldStr).join(newStr) : original.replace(oldStr, newStr);
    try {
      await fs.writeFile(check.resolved, updated, 'utf8');
      const delta = updated.length - original.length;
      return {
        ok: true,
        content: `已编辑 ${check.resolved}, 替换 ${replaceAll ? occurrences : 1} 处, 文件大小变化 ${delta >= 0 ? '+' : ''}${delta} 字节`,
      };
    } catch (err) {
      return { ok: false, content: `写入失败: ${(err as Error).message}` };
    }
  },
});

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}
