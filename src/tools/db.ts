import { config } from '../config.js';
import type { DbProfile } from '../config.js';
import { logger } from '../logger.js';
import { registerTool } from './registry.js';
import type { ToolResult } from '../agent/types.js';

type RowValue = string | number | boolean | bigint | Date | Buffer | null | undefined;
type RowObject = Record<string, RowValue>;

interface QueryResult {
  fields: string[];
  rows: RowObject[];
  affectedRows?: number;
}

const READ_ONLY_HEADS = new Set([
  'select',
  'show',
  'describe',
  'desc',
  'explain',
  'analyze',
]);

const DANGEROUS_SQL_PATTERNS: RegExp[] = [
  /\binto\s+(out|dump)file\b/i,
  /\bload\s+data\b/i,
  /\bload_file\s*\(/i,
  /\bsleep\s*\(/i,
  /\bbenchmark\s*\(/i,
  /\bpg_sleep\s*\(/i,
];

function findProfile(name: string): DbProfile | null {
  return config.db.profiles.find((p) => p.name === name) ?? null;
}

function listProfileNames(): string[] {
  return config.db.profiles.map((p) => p.name);
}

function normalizeSql(raw: string): string {
  return raw.trim().replace(/;\s*$/, '');
}

function firstKeyword(sql: string): string {
  const m = sql.trimStart().match(/^(\w+)/);
  return (m?.[1] ?? '').toLowerCase();
}

function validateReadOnly(sql: string): string | null {
  const head = firstKeyword(sql);
  if (!READ_ONLY_HEADS.has(head)) {
    return `read-only tool rejects keyword "${head}". Allowed: ${[...READ_ONLY_HEADS].join(', ')}`;
  }
  return null;
}

function validateNoMultiStatement(sql: string): string | null {
  const idx = sql.indexOf(';');
  if (idx >= 0 && sql.slice(idx + 1).trim().length > 0) {
    return 'multiple statements are not allowed';
  }
  return null;
}

function validateNoDangerousPatterns(sql: string): string | null {
  for (const re of DANGEROUS_SQL_PATTERNS) {
    if (re.test(sql)) return `dangerous SQL pattern: ${re.source}`;
  }
  return null;
}

function hasLimitClause(sql: string): boolean {
  return /\blimit\s+\d/i.test(sql);
}

function enforceLimit(sql: string, requestedLimit: number | undefined): string {
  const head = firstKeyword(sql);
  if (head !== 'select' && head !== 'with') return sql;
  if (hasLimitClause(sql)) return sql;
  const clamped = Math.min(
    Math.max(requestedLimit ?? config.db.defaultLimit, 1),
    config.db.maxRows,
  );
  return `${sql} LIMIT ${clamped}`;
}

let mysqlPools: Map<string, import('mysql2/promise').Pool> | null = null;
let pgPools: Map<string, import('pg').Pool> | null = null;

async function getMysqlPool(profile: DbProfile): Promise<import('mysql2/promise').Pool> {
  if (!mysqlPools) mysqlPools = new Map();
  const existing = mysqlPools.get(profile.name);
  if (existing) return existing;
  const { createPool } = await import('mysql2/promise');
  const pool = createPool({
    uri: profile.dsn,
    connectionLimit: 5,
    waitForConnections: true,
    connectTimeout: 10_000,
  });
  mysqlPools.set(profile.name, pool);
  return pool;
}

async function getPgPool(profile: DbProfile): Promise<import('pg').Pool> {
  if (!pgPools) pgPools = new Map();
  const existing = pgPools.get(profile.name);
  if (existing) return existing;
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: profile.dsn,
    max: 5,
    connectionTimeoutMillis: 10_000,
    query_timeout: config.db.timeoutMs,
    statement_timeout: config.db.timeoutMs,
  });
  pgPools.set(profile.name, pool);
  return pool;
}

async function executeMysql(profile: DbProfile, sql: string): Promise<QueryResult> {
  const pool = await getMysqlPool(profile);
  const [rows, fields] = await pool.query(sql);
  if (Array.isArray(rows)) {
    const fieldNames = Array.isArray(fields)
      ? fields.map((f) => (f as { name: string }).name)
      : [];
    return { fields: fieldNames, rows: rows as RowObject[] };
  }
  const okPacket = rows as { affectedRows?: number };
  return { fields: [], rows: [], affectedRows: okPacket.affectedRows ?? 0 };
}

async function executePg(profile: DbProfile, sql: string): Promise<QueryResult> {
  const pool = await getPgPool(profile);
  const res = await pool.query(sql);
  const fields = res.fields?.map((f) => f.name) ?? [];
  return {
    fields,
    rows: res.rows as RowObject[],
    affectedRows: typeof res.rowCount === 'number' ? res.rowCount : undefined,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runQuery(profile: DbProfile, sql: string): Promise<QueryResult> {
  const exec = profile.driver === 'mysql' ? executeMysql : executePg;
  return withTimeout(exec(profile, sql), config.db.timeoutMs, 'db query');
}

function formatCell(v: RowValue, maxCharsPerCell: number): string {
  if (v == null) return 'NULL';
  if (Buffer.isBuffer(v)) return `<buffer ${v.length}B>`;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      return s.length > maxCharsPerCell ? `${s.slice(0, maxCharsPerCell)}…` : s;
    } catch {
      return '<unserializable>';
    }
  }
  const s = String(v);
  return s.length > maxCharsPerCell ? `${s.slice(0, maxCharsPerCell)}…` : s;
}

function formatResult(result: QueryResult, profileName: string, sql: string): string {
  if (result.fields.length === 0) {
    return [
      `profile=${profileName}`,
      `sql: ${sql}`,
      `affectedRows=${result.affectedRows ?? 0}`,
    ].join('\n');
  }

  const header = result.fields;
  const lines: string[] = [];
  lines.push(header.join('\t'));
  lines.push(header.map(() => '---').join('\t'));
  let totalChars = 0;
  const cap = 1_000_000;
  for (const row of result.rows) {
    const cells = header.map((h) => formatCell(row[h], 200));
    const line = cells.join('\t');
    if (totalChars + line.length > cap) {
      lines.push('... (output truncated, exceeded 1MB)');
      break;
    }
    lines.push(line);
    totalChars += line.length;
  }
  return [
    `profile=${profileName} sql=${sql}`,
    `rows=${result.rows.length} cols=${header.length}`,
    '',
    lines.join('\n'),
  ].join('\n');
}

function profilesHelp(): string {
  const names = listProfileNames();
  if (names.length === 0) {
    return '(DB_PROFILES is empty in .env, no databases configured)';
  }
  return `available profiles: ${names.join(', ')}`;
}

registerTool({
  name: 'db_query',
  description:
    '对配置的业务数据库执行只读 SQL (SELECT/SHOW/DESCRIBE/EXPLAIN)。' +
    '凭据来自 .env DB_PROFILES, LLM 只填 profile 名而非 DSN。' +
    '禁止多语句、INTO OUTFILE、LOAD DATA、SLEEP 等危险用法。' +
    '没有 LIMIT 子句时会自动追加 LIMIT (默认 100, 单次最大 1000)。',
  parameters: {
    type: 'object',
    properties: {
      profile: {
        type: 'string',
        description: '.env 里 DB_PROFILES 配的连接名 (例如 main_ro)',
      },
      sql: {
        type: 'string',
        description: '单条只读 SQL, 必须以 SELECT / SHOW / DESCRIBE / EXPLAIN 开头',
      },
      limit: {
        type: 'integer',
        description: `没显式 LIMIT 时追加的上限。默认 ${config.db.defaultLimit}, 最大 ${config.db.maxRows}`,
      },
    },
    required: ['profile', 'sql'],
    additionalProperties: false,
  },
  async handler(args): Promise<ToolResult> {
    const profileName = String(args.profile ?? '').trim();
    const rawSql = String(args.sql ?? '');
    if (!profileName) {
      return { ok: false, content: `profile required. ${profilesHelp()}` };
    }
    const profile = findProfile(profileName);
    if (!profile) {
      return { ok: false, content: `unknown profile "${profileName}". ${profilesHelp()}` };
    }
    if (!rawSql.trim()) return { ok: false, content: 'sql required' };

    const sql = normalizeSql(rawSql);
    for (const validator of [validateNoMultiStatement, validateReadOnly, validateNoDangerousPatterns]) {
      const err = validator(sql);
      if (err) return { ok: false, content: `rejected: ${err}` };
    }

    const limited = enforceLimit(sql, Number(args.limit) || undefined);

    try {
      const result = await runQuery(profile, limited);
      return { ok: true, content: formatResult(result, profile.name, limited) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, profile: profile.name }, 'db_query failed');
      return { ok: false, content: `query failed: ${msg}` };
    }
  },
});

registerTool({
  name: 'db_write',
  description:
    '对配置的业务数据库执行写入 SQL (INSERT/UPDATE/DELETE/REPLACE/MERGE 等)。' +
    '每次调用都会请求用户审批。仍然禁止多语句、INTO OUTFILE、LOAD DATA。' +
    '凭据来自 .env DB_PROFILES, LLM 只填 profile 名而非 DSN。',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      profile: {
        type: 'string',
        description: '.env 里 DB_PROFILES 配的连接名 (建议用读写账号 e.g. main_rw)',
      },
      sql: {
        type: 'string',
        description: '单条写入 SQL',
      },
    },
    required: ['profile', 'sql'],
    additionalProperties: false,
  },
  async confirm(args) {
    const profile = String(args.profile ?? '');
    const sql = String(args.sql ?? '');
    return {
      summary: `执行写入 SQL on ${profile}: ${sql.length > 100 ? `${sql.slice(0, 100)}...` : sql}`,
      details: `profile: ${profile}\n完整 SQL:\n${sql}`,
    };
  },
  async handler(args): Promise<ToolResult> {
    const profileName = String(args.profile ?? '').trim();
    const rawSql = String(args.sql ?? '');
    if (!profileName) {
      return { ok: false, content: `profile required. ${profilesHelp()}` };
    }
    const profile = findProfile(profileName);
    if (!profile) {
      return { ok: false, content: `unknown profile "${profileName}". ${profilesHelp()}` };
    }
    if (!rawSql.trim()) return { ok: false, content: 'sql required' };

    const sql = normalizeSql(rawSql);
    for (const validator of [validateNoMultiStatement, validateNoDangerousPatterns]) {
      const err = validator(sql);
      if (err) return { ok: false, content: `拒绝执行: ${err}` };
    }

    try {
      const result = await runQuery(profile, sql);
      return { ok: true, content: formatResult(result, profile.name, sql) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, profile: profile.name }, 'db_write failed');
      return { ok: false, content: `db_write failed: ${msg}` };
    }
  },
});

export const _internal = {
  validateReadOnly,
  validateNoMultiStatement,
  validateNoDangerousPatterns,
  enforceLimit,
  normalizeSql,
};

export async function closeAllPools(): Promise<void> {
  if (mysqlPools) {
    for (const p of mysqlPools.values()) await p.end();
    mysqlPools.clear();
  }
  if (pgPools) {
    for (const p of pgPools.values()) await p.end();
    pgPools.clear();
  }
}
