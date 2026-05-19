import fs from 'node:fs/promises';
import { registerTool } from './registry.js';
import { checkPath } from './paths.js';
import type { ToolResult } from '../agent/types.js';

const MAX_BYTES = 200_000;

registerTool({
  name: 'read_file',
  description:
    'Read a UTF-8 text file from inside ALLOWED_PATHS. Returns up to ~200 KB. ' +
    'Use offset/limit to page through larger files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute file path inside ALLOWED_PATHS.' },
      offset: { type: 'integer', description: 'Line offset (1-based). Default 1.' },
      limit: { type: 'integer', description: 'Max lines to return. Default 500, max 5000.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async handler(args): Promise<ToolResult> {
    const target = String(args.path ?? '');
    if (!target) return { ok: false, content: 'path required' };
    const check = checkPath(target, false);
    if (!check.ok) return { ok: false, content: check.reason ?? 'path rejected' };

    let stat;
    try {
      stat = await fs.stat(check.resolved);
    } catch (err) {
      return { ok: false, content: `stat failed: ${(err as Error).message}` };
    }
    if (!stat.isFile()) return { ok: false, content: 'target is not a file' };
    if (stat.size > MAX_BYTES * 8) {
      return {
        ok: false,
        content: `file too large: ${stat.size} bytes. Use shell_ro 'tail -n N path' to sample.`,
      };
    }

    let buf: string;
    try {
      buf = await fs.readFile(check.resolved, 'utf8');
    } catch (err) {
      return { ok: false, content: `read failed: ${(err as Error).message}` };
    }

    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.min(Math.max(Number(args.limit) || 500, 1), 5000);
    const allLines = buf.split('\n');
    const slice = allLines.slice(offset - 1, offset - 1 + limit);
    const header = `path=${check.resolved} lines=${allLines.length} showing=${offset}-${offset + slice.length - 1}`;
    const body = slice.map((ln, i) => `${offset + i}\t${ln}`).join('\n');
    return { ok: true, content: `${header}\n${body}` };
  },
});
