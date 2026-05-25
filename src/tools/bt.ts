import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { config } from '../config.js';
import { registerTool } from './registry.js';
import { logger } from '../logger.js';
import type { ToolResult } from '../agent/types.js';

const TRUNCATE_LIMIT = 8000;

function md5(s: string): string {
  return createHash('md5').update(s).digest('hex');
}

function buildAuthBody(extra: Record<string, string | number | undefined>): URLSearchParams {
  const requestTime = Math.floor(Date.now() / 1000);
  const requestToken = md5(`${requestTime}${md5(config.bt.apiKey)}`);
  const params = new URLSearchParams();
  params.set('request_time', String(requestTime));
  params.set('request_token', requestToken);
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  return params;
}

interface BtRequestOpts {
  endpoint: string;
  params: Record<string, string | number | undefined>;
}

async function btRequest(opts: BtRequestOpts): Promise<unknown> {
  if (!config.bt.enabled) {
    throw new Error('宝塔 API 未配置');
  }
  const url = new URL(opts.endpoint, `${config.bt.panelUrl}/`);
  const body = buildAuthBody(opts.params).toString();
  const isHttps = url.protocol === 'https:';
  const reqFn = isHttps ? httpsRequest : httpRequest;

  return await new Promise<unknown>((resolve, reject) => {
    const req = reqFn(
      {
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'ai-ops-agent/0.0.1',
        },
        timeout: config.bt.timeoutMs,
        ...(isHttps && config.bt.tlsInsecure ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode ?? '?'}: ${text.slice(0, 200)}`));
            return;
          }
          const ctype = String(res.headers['content-type'] ?? '');
          if (!ctype.toLowerCase().includes('json')) {
            reject(new Error(`non-JSON response (${ctype || 'unknown'}): ${text.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reject(new Error(`parse JSON failed: ${msg}`));
          }
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`request timeout after ${config.bt.timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function ensureEnabled(): ToolResult | null {
  if (!config.bt.enabled) {
    return {
      ok: false,
      content: '宝塔 API 未配置, 请在 .env 设置 BT_PANEL_URL + BT_API_KEY',
    };
  }
  return null;
}

function checkBtPath(p: string): string | null {
  const norm = p.replace(/\\/g, '/').replace(/\/+/g, '/');
  for (const deny of config.tools.denyPaths) {
    const dnorm = deny.replace(/\\/g, '/').replace(/\/+/g, '/');
    if (norm === dnorm || norm.startsWith(`${dnorm}/`)) {
      return `path denied: ${p}`;
    }
  }
  return null;
}

function truncate(s: string, max = TRUNCATE_LIMIT): { content: string; truncated: boolean } {
  if (s.length <= max) return { content: s, truncated: false };
  return {
    content: `${s.slice(0, max)}\n... [truncated ${s.length - max} chars]`,
    truncated: true,
  };
}

function formatErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `bt api error: ${msg}`;
}

function isErrorPayload(data: unknown): { error: true; msg: string } | { error: false } {
  if (typeof data !== 'object' || data === null) {
    return { error: true, msg: 'unexpected response shape' };
  }
  const obj = data as Record<string, unknown>;
  if (obj.status === false) {
    return { error: true, msg: String(obj.msg ?? 'unknown error') };
  }
  return { error: false };
}

function asArray(data: unknown): Array<Record<string, unknown>> {
  if (typeof data !== 'object' || data === null) return [];
  const obj = data as Record<string, unknown>;
  return Array.isArray(obj.data) ? (obj.data as Array<Record<string, unknown>>) : [];
}

// 1. bt_sites_list
registerTool({
  name: 'bt_sites_list',
  description:
    '列出宝塔面板的站点 (domain/PHP 版本/状态/到期). 支持分页 + 关键字搜索. 只读, 无需审批.',
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'integer', description: '页码, 从 1 开始' },
      limit: { type: 'integer', description: '每页条数, 默认 20, 最大 200' },
      search: { type: 'string', description: '关键字, 模糊匹配 domain' },
    },
    additionalProperties: false,
  },
  async handler(args): Promise<ToolResult> {
    const guard = ensureEnabled();
    if (guard) return guard;
    const page = Math.max(1, Number(args.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 20));
    const search = typeof args.search === 'string' ? args.search : '';
    try {
      const data = await btRequest({
        endpoint: '/data?action=getData',
        params: { table: 'sites', p: page, limit, search },
      });
      const err = isErrorPayload(data);
      if (err.error) return { ok: false, content: `bt api error: ${err.msg}` };
      const rows = asArray(data);
      const lines = rows.map((x) => {
        const running = x.status === '1' || x.status === 1;
        return `[#${x.id}] ${x.name} | 状态:${running ? '运行' : '停止'} | PHP:${x.php_version ?? '-'} | SSL:${x.ssl ?? '-'} | 到期:${x.edate ?? '-'} | path:${x.path ?? '-'}`;
      });
      const t = truncate([`共 ${rows.length} 站点 (page=${page} limit=${limit})`, ...lines].join('\n'));
      return { ok: true, content: t.content, truncated: t.truncated };
    } catch (err) {
      return { ok: false, content: formatErr(err) };
    }
  },
});

// 2. bt_site_op (dangerous)
registerTool({
  name: 'bt_site_op',
  description:
    '对宝塔站点执行启停或修改 PHP 版本. 需审批. action: start | stop | set_php. 提供 site_id 或 site_name 之一. set_php 时 php_version 必填 (如 "74" / "80" / "81").',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'stop', 'set_php'] },
      site_id: { type: 'integer', description: '站点 id (来自 bt_sites_list)' },
      site_name: { type: 'string', description: '站点 domain, 如 example.com' },
      php_version: { type: 'string', description: 'set_php 时必填' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  dangerous: true,
  confirm(args) {
    const action = String(args.action ?? '');
    const ident = args.site_name ?? `#${args.site_id ?? '?'}`;
    const phpInfo = action === 'set_php' ? ` → PHP ${args.php_version ?? '?'}` : '';
    return {
      summary: `宝塔 ${action} 站点 ${ident}${phpInfo}`,
      details: JSON.stringify(args, null, 2),
    };
  },
  async handler(args): Promise<ToolResult> {
    const guard = ensureEnabled();
    if (guard) return guard;
    const action = String(args.action ?? '');
    if (!['start', 'stop', 'set_php'].includes(action)) {
      return { ok: false, content: `unknown action: ${action}` };
    }
    let siteId = args.site_id ? Number(args.site_id) : undefined;
    const siteName = typeof args.site_name === 'string' ? args.site_name : undefined;
    if (!siteId && !siteName) {
      return { ok: false, content: '必须提供 site_id 或 site_name' };
    }
    if (!siteId && siteName) {
      try {
        const data = await btRequest({
          endpoint: '/data?action=getData',
          params: { table: 'sites', p: 1, limit: 200, search: siteName },
        });
        const rows = asArray(data);
        const found = rows.find((r) => r.name === siteName);
        if (!found) return { ok: false, content: `站点未找到: ${siteName}` };
        siteId = Number(found.id);
      } catch (err) {
        return { ok: false, content: formatErr(err) };
      }
    }
    try {
      let endpoint: string;
      const params: Record<string, string | number> = {};
      if (action === 'start') {
        endpoint = '/site?action=SiteStart';
        params.id = siteId!;
        params.name = siteName ?? '';
      } else if (action === 'stop') {
        endpoint = '/site?action=SiteStop';
        params.id = siteId!;
        params.name = siteName ?? '';
      } else {
        if (!args.php_version) return { ok: false, content: 'set_php 需提供 php_version' };
        endpoint = '/site?action=SetPHPVersion';
        params.siteName = siteName ?? '';
        params.version = String(args.php_version);
      }
      const data = await btRequest({ endpoint, params });
      const err = isErrorPayload(data);
      if (err.error) return { ok: false, content: `bt api error: ${err.msg}` };
      return {
        ok: true,
        content: `成功: ${action} ${siteName ?? `#${siteId}`}\n面板返回: ${JSON.stringify(data)}`,
      };
    } catch (err) {
      return { ok: false, content: formatErr(err) };
    }
  },
});

// 3. bt_db_list
registerTool({
  name: 'bt_db_list',
  description: '列出宝塔面板托管的数据库 (id/name/user/type/备注). 只读.',
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'integer' },
      limit: { type: 'integer' },
      search: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(args): Promise<ToolResult> {
    const guard = ensureEnabled();
    if (guard) return guard;
    const page = Math.max(1, Number(args.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 20));
    const search = typeof args.search === 'string' ? args.search : '';
    try {
      const data = await btRequest({
        endpoint: '/data?action=getData',
        params: { table: 'databases', p: page, limit, search },
      });
      const err = isErrorPayload(data);
      if (err.error) return { ok: false, content: `bt api error: ${err.msg}` };
      const rows = asArray(data);
      const lines = rows.map(
        (r) => `[#${r.id}] ${r.name} | user:${r.username ?? '-'} | type:${r.type ?? '-'} | ps:${r.ps ?? '-'}`,
      );
      const t = truncate([`共 ${rows.length} 库`, ...lines].join('\n'));
      return { ok: true, content: t.content, truncated: t.truncated };
    } catch (err) {
      return { ok: false, content: formatErr(err) };
    }
  },
});

// 4. bt_db_backup (dangerous)
registerTool({
  name: 'bt_db_backup',
  description: '触发宝塔面板对指定数据库进行备份, 备份产物落在面板默认备份目录. 需审批.',
  parameters: {
    type: 'object',
    properties: {
      db_id: { type: 'integer' },
      db_name: { type: 'string' },
    },
    additionalProperties: false,
  },
  dangerous: true,
  confirm(args) {
    const ident = args.db_name ?? `#${args.db_id ?? '?'}`;
    return { summary: `宝塔备份数据库 ${ident}`, details: JSON.stringify(args, null, 2) };
  },
  async handler(args): Promise<ToolResult> {
    const guard = ensureEnabled();
    if (guard) return guard;
    let dbId = args.db_id ? Number(args.db_id) : undefined;
    const dbName = typeof args.db_name === 'string' ? args.db_name : undefined;
    if (!dbId && !dbName) return { ok: false, content: '必须提供 db_id 或 db_name' };
    if (!dbId && dbName) {
      try {
        const data = await btRequest({
          endpoint: '/data?action=getData',
          params: { table: 'databases', p: 1, limit: 200, search: dbName },
        });
        const rows = asArray(data);
        const found = rows.find((r) => r.name === dbName);
        if (!found) return { ok: false, content: `数据库未找到: ${dbName}` };
        dbId = Number(found.id);
      } catch (err) {
        return { ok: false, content: formatErr(err) };
      }
    }
    try {
      const data = await btRequest({
        endpoint: '/database?action=ToBackup',
        params: { id: dbId! },
      });
      const err = isErrorPayload(data);
      if (err.error) return { ok: false, content: `bt api error: ${err.msg}` };
      return {
        ok: true,
        content: `备份完成: ${dbName ?? `#${dbId}`}\n面板返回: ${JSON.stringify(data)}`,
      };
    } catch (err) {
      return { ok: false, content: formatErr(err) };
    }
  },
});

// 5. bt_file_op (dangerous; DENY_PATHS 校验)
registerTool({
  name: 'bt_file_op',
  description:
    '通过宝塔文件管理 API 读/写/建目录. action: read | write | mkdir. 路径仍受 DENY_PATHS 限制 (如 .env / /etc/shadow 等). 全部走审批.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'write', 'mkdir'] },
      path: { type: 'string', description: '绝对路径' },
      content: { type: 'string', description: 'write 时的文件内容' },
      encoding: { type: 'string', description: 'write 时编码, 默认 utf-8' },
    },
    required: ['action', 'path'],
    additionalProperties: false,
  },
  dangerous: true,
  confirm(args) {
    const contentHint =
      typeof args.content === 'string' ? `<${args.content.length} chars>` : undefined;
    return {
      summary: `宝塔 ${args.action} 文件 ${args.path}`,
      details: JSON.stringify({ ...args, content: contentHint }, null, 2),
    };
  },
  async handler(args): Promise<ToolResult> {
    const guard = ensureEnabled();
    if (guard) return guard;
    const action = String(args.action ?? '');
    const filePath = typeof args.path === 'string' ? args.path : '';
    if (!filePath) return { ok: false, content: 'path required' };
    const deny = checkBtPath(filePath);
    if (deny) return { ok: false, content: deny };
    try {
      if (action === 'read') {
        const data = await btRequest({
          endpoint: '/files?action=GetFileBody',
          params: { path: filePath },
        });
        const err = isErrorPayload(data);
        if (err.error) return { ok: false, content: `bt api error: ${err.msg}` };
        const obj = data as { data?: string };
        const text = typeof obj.data === 'string' ? obj.data : JSON.stringify(data);
        const t = truncate(text);
        return { ok: true, content: t.content, truncated: t.truncated };
      }
      if (action === 'write') {
        const content = typeof args.content === 'string' ? args.content : '';
        const encoding = typeof args.encoding === 'string' ? args.encoding : 'utf-8';
        const data = await btRequest({
          endpoint: '/files?action=SaveFileBody',
          params: { path: filePath, data: content, encoding },
        });
        const err = isErrorPayload(data);
        if (err.error) return { ok: false, content: `bt api error: ${err.msg}` };
        return { ok: true, content: `写入成功: ${filePath} (${content.length} chars)` };
      }
      if (action === 'mkdir') {
        const data = await btRequest({
          endpoint: '/files?action=CreateDir',
          params: { path: filePath },
        });
        const err = isErrorPayload(data);
        if (err.error) return { ok: false, content: `bt api error: ${err.msg}` };
        return { ok: true, content: `目录创建: ${filePath}` };
      }
      return { ok: false, content: `unknown action: ${action}` };
    } catch (err) {
      return { ok: false, content: formatErr(err) };
    }
  },
});

// 6. bt_ssl_check (read-only)
registerTool({
  name: 'bt_ssl_check',
  description:
    '查询宝塔站点 SSL 证书信息 (有效期/issuer/days_left). 不传 site_name 则枚举所有站点. 只读.',
  parameters: {
    type: 'object',
    properties: {
      site_name: { type: 'string', description: '站点 domain, 留空查全部' },
    },
    additionalProperties: false,
  },
  async handler(args): Promise<ToolResult> {
    const guard = ensureEnabled();
    if (guard) return guard;
    const siteName = typeof args.site_name === 'string' ? args.site_name : '';
    try {
      const targets: string[] = [];
      if (siteName) {
        targets.push(siteName);
      } else {
        const data = await btRequest({
          endpoint: '/data?action=getData',
          params: { table: 'sites', p: 1, limit: 500 },
        });
        for (const r of asArray(data)) {
          if (typeof r.name === 'string') targets.push(r.name);
        }
      }
      const lines: string[] = [];
      for (const name of targets) {
        try {
          const data = await btRequest({
            endpoint: '/site?action=GetSSL',
            params: { siteName: name },
          });
          const obj = data as Record<string, unknown>;
          const info = (typeof obj.info === 'object' && obj.info !== null ? obj.info : obj) as Record<
            string,
            unknown
          >;
          const notAfter = String(info.not_after ?? info.notAfter ?? '');
          const subject = String(info.subject ?? '');
          const issuer = String(info.issuer ?? '');
          let daysLeft = '-';
          if (notAfter) {
            const exp = new Date(notAfter.replace(' ', 'T'));
            if (!Number.isNaN(exp.getTime())) {
              daysLeft = String(Math.floor((exp.getTime() - Date.now()) / 86_400_000));
            }
          }
          lines.push(
            `${name} | 剩余:${daysLeft}d | not_after:${notAfter || '-'} | issuer:${issuer || '-'} | subject:${subject || '-'}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          lines.push(`${name} | 查询失败: ${msg}`);
        }
      }
      const t = truncate([`共 ${targets.length} 站点`, ...lines].join('\n'));
      return { ok: true, content: t.content, truncated: t.truncated };
    } catch (err) {
      return { ok: false, content: formatErr(err) };
    }
  },
});

// 7. bt_cron (list-only; add/delete 留下轮)
registerTool({
  name: 'bt_cron',
  description: '宝塔计划任务管理. 当前仅支持 action=list (add/delete 留下轮). 走审批.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list'] },
      page: { type: 'integer' },
      limit: { type: 'integer' },
      search: { type: 'string' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  dangerous: true,
  confirm(args) {
    return { summary: `宝塔 ${args.action} 计划任务`, details: JSON.stringify(args, null, 2) };
  },
  async handler(args): Promise<ToolResult> {
    const guard = ensureEnabled();
    if (guard) return guard;
    if (args.action !== 'list') {
      return { ok: false, content: 'add/delete 暂未实现, 仅支持 list' };
    }
    const page = Math.max(1, Number(args.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 20));
    const search = typeof args.search === 'string' ? args.search : '';
    try {
      const data = await btRequest({
        endpoint: '/data?action=getData',
        params: { table: 'crontab', p: page, limit, search },
      });
      const err = isErrorPayload(data);
      if (err.error) return { ok: false, content: `bt api error: ${err.msg}` };
      const rows = asArray(data);
      const lines = rows.map((r) => {
        const enabled = r.status === '1' || r.status === 1;
        return `[#${r.id}] ${r.name} | type:${r.type ?? '-'} | sName:${r.sName ?? '-'} | status:${enabled ? '启用' : '禁用'} | ps:${r.ps ?? '-'}`;
      });
      const t = truncate([`共 ${rows.length} 任务`, ...lines].join('\n'));
      return { ok: true, content: t.content, truncated: t.truncated };
    } catch (err) {
      return { ok: false, content: formatErr(err) };
    }
  },
});

// 8. bt_logs_recent (read-only)
registerTool({
  name: 'bt_logs_recent',
  description:
    '读宝塔站点的 access 或 error 日志, 取尾部 N 行. type=access|error. lines 默认 100, 最大 1000. 仅支持默认 /www/wwwlogs 路径布局.',
  parameters: {
    type: 'object',
    properties: {
      site_name: { type: 'string', description: '站点 domain' },
      type: { type: 'string', enum: ['access', 'error'] },
      lines: { type: 'integer', description: '尾部行数, 默认 100, 最大 1000' },
    },
    required: ['site_name', 'type'],
    additionalProperties: false,
  },
  async handler(args): Promise<ToolResult> {
    const guard = ensureEnabled();
    if (guard) return guard;
    const siteName = String(args.site_name ?? '');
    const type = String(args.type ?? '');
    const lines = Math.min(1000, Math.max(1, Number(args.lines) || 100));
    if (!siteName) return { ok: false, content: 'site_name required' };
    if (type !== 'access' && type !== 'error') {
      return { ok: false, content: 'type must be access|error' };
    }
    const logPath =
      type === 'access' ? `/www/wwwlogs/${siteName}.log` : `/www/wwwlogs/${siteName}.log.wf`;
    const deny = checkBtPath(logPath);
    if (deny) return { ok: false, content: deny };
    try {
      const data = await btRequest({
        endpoint: '/files?action=GetFileBody',
        params: { path: logPath },
      });
      const err = isErrorPayload(data);
      if (err.error) return { ok: false, content: `bt api error: ${err.msg}` };
      const text = String((data as { data?: string }).data ?? '');
      const all = text.split(/\r?\n/);
      const tail = all.slice(-lines).join('\n');
      const t = truncate(`# ${logPath} (last ${lines} lines)\n${tail}`);
      return { ok: true, content: t.content, truncated: t.truncated };
    } catch (err) {
      return { ok: false, content: formatErr(err) };
    }
  },
});

logger.debug('bt tools loaded');
