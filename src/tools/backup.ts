import { execa } from 'execa';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { config } from '../config.js';
import { checkPath } from './paths.js';
import { registerTool } from './registry.js';
import type { ToolResult } from '../agent/types.js';

const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

interface DbDsn {
  driver: 'mysql' | 'postgres';
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
}

function parseDsn(dsn: string): DbDsn | null {
  try {
    const u = new URL(dsn);
    let driver: DbDsn['driver'];
    if (u.protocol === 'mysql:' || u.protocol === 'mariadb:') driver = 'mysql';
    else if (u.protocol === 'postgres:' || u.protocol === 'postgresql:') driver = 'postgres';
    else return null;
    return {
      driver,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      host: u.hostname || '127.0.0.1',
      port: Number(u.port) || (driver === 'mysql' ? 3306 : 5432),
      database: u.pathname.replace(/^\//, ''),
    };
  } catch {
    return null;
  }
}

function timestamp(): string {
  const d = new Date();
  const z = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

async function spawnDumpToFile(
  cmd: string,
  args: string[],
  destPath: string,
  env?: Record<string, string>,
): Promise<{ ok: boolean; code: number; stderr: string }> {
  return await new Promise((resolve) => {
    const out = fs.createWriteStream(destPath);
    const proc = spawn(cmd, args, { env: env ? { ...process.env, ...env } : process.env });
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGTERM'), 600_000);
    proc.stdout.pipe(out);
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      out.end();
      resolve({ ok: false, code: -1, stderr: err.message });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      out.end();
      resolve({ ok: code === 0, code: code ?? -1, stderr });
    });
  });
}

async function diskUsageMb(paths: string[]): Promise<number> {
  try {
    const proc = await execa('du', ['-sb', ...paths], { reject: false, all: true });
    if (proc.failed) return -1;
    const total = (proc.stdout ?? '')
      .split('\n')
      .map((line) => Number(line.split(/\s+/)[0] ?? 0))
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => a + b, 0);
    return Math.round(total / 1024 / 1024);
  } catch {
    return -1;
  }
}

registerTool({
  name: 'backup_create',
  description:
    'tar.gz 打包指定目录, 可选附带数据库 dump (用 .env 中 DB_PROFILES 的名称). 落点 BACKUP_DIR. 走审批. ' +
    'paths 必须全部位于 ALLOWED_PATHS 且不在 DENY_PATHS. 单次产物上限 BACKUP_MAX_SIZE_MB.',
  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: '要打包的目录或文件 (绝对路径), 至少 1 个 (除非 db_profile_only=true)',
      },
      db_profile: { type: 'string', description: '可选 DB_PROFILES 中的 profile 名, 顺手 dump 数据库' },
      output_name: { type: 'string', description: '产物文件名, 仅 [a-zA-Z0-9._-], 默认 backup-<时间戳>.tar.gz' },
      db_profile_only: { type: 'boolean', description: 'true = 仅 dump 数据库, 忽略 paths' },
    },
    additionalProperties: false,
  },
  dangerous: true,
  confirm(args) {
    const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
    const db = args.db_profile ? ` + db:${args.db_profile}` : '';
    return {
      summary: `backup ${paths.length} paths${db} → ${config.backup.dir}`,
      details: JSON.stringify(args, null, 2),
    };
  },
  async handler(args): Promise<ToolResult> {
    const dbProfileOnly = args.db_profile_only === true;
    const rawPaths = Array.isArray(args.paths) ? (args.paths as unknown[]) : [];
    const paths = rawPaths.filter((p): p is string => typeof p === 'string' && p.length > 0);
    const dbProfile = typeof args.db_profile === 'string' ? args.db_profile : '';
    const outputName =
      typeof args.output_name === 'string' && args.output_name
        ? args.output_name
        : `backup-${timestamp()}.tar.gz`;

    if (!SAFE_NAME_RE.test(outputName)) {
      return { ok: false, content: `output_name 不合法 (限 [a-zA-Z0-9._-]): ${outputName}` };
    }
    if (!dbProfileOnly && paths.length === 0) {
      return { ok: false, content: 'paths 至少 1 个 (或 db_profile_only=true)' };
    }

    // 校验所有 path
    const resolvedPaths: string[] = [];
    for (const p of paths) {
      const c = checkPath(p, false);
      if (!c.ok) return { ok: false, content: `path 拒绝: ${p} — ${c.reason}` };
      if (!fs.existsSync(c.resolved)) return { ok: false, content: `path 不存在: ${c.resolved}` };
      resolvedPaths.push(c.resolved);
    }

    // 校验 BACKUP_DIR 可写
    try {
      fs.mkdirSync(config.backup.dir, { recursive: true });
      fs.accessSync(config.backup.dir, fs.constants.W_OK);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `BACKUP_DIR 不可写 ${config.backup.dir}: ${msg}` };
    }

    // 估算大小 (仅 paths, db dump 大小不可预知)
    if (resolvedPaths.length > 0) {
      const sizeMb = await diskUsageMb(resolvedPaths);
      if (sizeMb > config.backup.maxSizeMb) {
        return {
          ok: false,
          content: `paths 估算 ${sizeMb}MB 超过 BACKUP_MAX_SIZE_MB=${config.backup.maxSizeMb}MB, 拒绝`,
        };
      }
    }

    const outputPath = path.join(config.backup.dir, outputName);
    if (fs.existsSync(outputPath)) {
      return { ok: false, content: `产物已存在, 改名后重试: ${outputPath}` };
    }

    const logLines: string[] = [];
    let dbDumpPath: string | null = null;

    // db dump
    if (dbProfile) {
      const profile = config.db.profiles.find((p) => p.name === dbProfile);
      if (!profile) {
        return { ok: false, content: `DB_PROFILES 中无 profile: ${dbProfile}` };
      }
      const dsn = parseDsn(profile.dsn);
      if (!dsn) return { ok: false, content: `profile DSN 解析失败: ${dbProfile}` };
      dbDumpPath = path.join(
        config.backup.dir,
        `${path.parse(outputName).name}.${dbProfile}.${dsn.driver === 'mysql' ? 'sql' : 'pgsql'}`,
      );
      try {
        if (dsn.driver === 'mysql') {
          const r = await spawnDumpToFile(
            'mysqldump',
            [
              `-h${dsn.host}`,
              `-P${dsn.port}`,
              `-u${dsn.user}`,
              `-p${dsn.password}`,
              '--single-transaction',
              '--quick',
              '--routines',
              dsn.database,
            ],
            dbDumpPath,
          );
          if (!r.ok) {
            return { ok: false, content: `mysqldump 失败 exit=${r.code}: ${r.stderr || '(no stderr)'}` };
          }
        } else {
          const r = await spawnDumpToFile(
            'pg_dump',
            ['-h', dsn.host, '-p', String(dsn.port), '-U', dsn.user, '-d', dsn.database, '-Fc'],
            dbDumpPath,
            { PGPASSWORD: dsn.password },
          );
          if (!r.ok) {
            return { ok: false, content: `pg_dump 失败 exit=${r.code}: ${r.stderr || '(no stderr)'}` };
          }
        }
        const stat = fs.statSync(dbDumpPath);
        logLines.push(`db dump → ${dbDumpPath} (${Math.round(stat.size / 1024)}KB)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, content: `db dump 异常: ${msg}` };
      }
    }

    // tar
    const tarTargets = [...resolvedPaths];
    if (dbDumpPath) tarTargets.push(dbDumpPath);
    if (tarTargets.length === 0) {
      return { ok: false, content: '无可打包内容' };
    }
    try {
      const proc = await execa(
        'tar',
        ['-czf', outputPath, '--absolute-names', ...tarTargets],
        { reject: false, all: true, timeout: 1_800_000 },
      );
      if (proc.failed) {
        return { ok: false, content: `tar 失败 exit=${proc.exitCode}:\n${proc.all ?? proc.stderr}` };
      }
      // 删 db dump 中间产物 (已进 tar)
      if (dbDumpPath) {
        try {
          fs.unlinkSync(dbDumpPath);
        } catch {
          /* ignore */
        }
      }
      const stat = fs.statSync(outputPath);
      const sizeMb = Math.round((stat.size / 1024 / 1024) * 10) / 10;
      logLines.push(`tar → ${outputPath} (${sizeMb}MB)`);
      return {
        ok: true,
        content: [`# backup_create 完成`, ...logLines, `paths: ${resolvedPaths.join(', ') || '(none)'}`].join('\n'),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `tar 异常: ${msg}` };
    }
  },
});
