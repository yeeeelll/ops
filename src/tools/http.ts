import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';
import { registerTool } from './registry.js';
import type { ToolResult } from '../agent/types.js';

function isPrivateIp(ip: string): boolean {
  if (!net.isIP(ip)) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip.startsWith('172.')) {
    const oct = Number(ip.split('.')[1]);
    if (oct >= 16 && oct <= 31) return true;
  }
  if (ip.toLowerCase().startsWith('fe80:')) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  return false;
}

const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

registerTool({
  name: 'http_probe',
  description:
    'GET 或 HEAD 任意 URL, 返回 status + 选定 headers + 响应体前 N 字节. 用于调试 webhook / 第三方 API / 健康检查. 默认允许私网地址 (本机服务调试), 可在 .env 关闭. 只读, 无审批.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s):// 完整 URL' },
      method: { type: 'string', enum: ['GET', 'HEAD'], description: '默认 GET' },
      timeout_ms: { type: 'integer', description: `默认 ${config.httpProbe.timeoutMs}, 最大 30000` },
      max_bytes: {
        type: 'integer',
        description: `响应体回读上限, 默认 ${config.httpProbe.maxBytes}, 最大 65536`,
      },
      headers: {
        type: 'object',
        description: '附加请求头, 例 {"Authorization": "Bearer xxx"}',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  async handler(args): Promise<ToolResult> {
    const rawUrl = String(args.url ?? '').trim();
    if (!rawUrl) return { ok: false, content: 'url required' };
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { ok: false, content: `invalid url: ${rawUrl}` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, content: `unsupported scheme: ${url.protocol}` };
    }
    const method = args.method === 'HEAD' ? 'HEAD' : 'GET';
    const timeoutMs = Math.min(30_000, Math.max(500, Number(args.timeout_ms) || config.httpProbe.timeoutMs));
    const maxBytes = Math.min(65_536, Math.max(64, Number(args.max_bytes) || config.httpProbe.maxBytes));

    if (!config.httpProbe.allowPrivate) {
      try {
        const records = await dns.lookup(url.hostname, { all: true });
        const privateHit = records.find((r) => isPrivateIp(r.address));
        if (privateHit) {
          return {
            ok: false,
            content: `private IP blocked: ${url.hostname} → ${privateHit.address} (set HTTP_PROBE_ALLOW_PRIVATE=true to permit)`,
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, content: `dns lookup failed: ${msg}` };
      }
    }

    const extraHeaders: Record<string, string> = {};
    if (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) {
      for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
        if (typeof v === 'string') extraHeaders[k] = v;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const resp = await fetch(url, {
        method,
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'ai-ops-agent/http_probe',
          Accept: '*/*',
          ...extraHeaders,
        },
      });
      const elapsed = Date.now() - started;

      let body = '';
      let bodyBytes = 0;
      let truncated = false;
      if (method === 'GET' && resp.body) {
        const reader = resp.body.getReader();
        const chunks: Buffer[] = [];
        while (bodyBytes < maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value));
          bodyBytes += value.byteLength;
        }
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        const buf = Buffer.concat(chunks).subarray(0, maxBytes);
        body = buf.toString('utf-8');
        truncated = bodyBytes >= maxBytes;
      }

      const headerLines: string[] = [];
      resp.headers.forEach((value, key) => {
        if (HOP_HEADERS.has(key.toLowerCase())) return;
        headerLines.push(`${key}: ${value}`);
      });

      const lines = [
        `${method} ${url.toString()}`,
        `HTTP ${resp.status} ${resp.statusText} (${elapsed}ms)`,
        '--- headers ---',
        ...headerLines,
      ];
      if (method === 'GET') {
        lines.push(`--- body (${bodyBytes} bytes${truncated ? ', truncated' : ''}) ---`);
        lines.push(body);
      }
      return { ok: resp.status < 400, content: lines.join('\n'), truncated };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const elapsed = Date.now() - started;
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        content: `http_probe failed (${elapsed}ms)${aborted ? ' [timeout]' : ''}: ${msg}`,
      };
    } finally {
      clearTimeout(timer);
    }
  },
});
