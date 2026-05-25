import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';

const csv = (s: string | undefined): string[] =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const csvNumbers = (s: string | undefined): number[] =>
  csv(s)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));

const Schema = z.object({
  OPENROUTER_API_KEY: z.string().min(10, 'OPENROUTER_API_KEY required'),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  LLM_MODEL: z.string().default('deepseek/deepseek-chat-v3.1'),
  OPENROUTER_APP_NAME: z.string().default('ai-ops-agent'),
  OPENROUTER_HTTP_REFERER: z.string().default('https://localhost'),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  LLM_CONTEXT_BUDGET: z.coerce.number().int().positive().default(120_000),
  LLM_COMPACT_THRESHOLD: z.coerce.number().min(0.1).max(0.95).default(0.8),

  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_ALLOWED_USER_IDS: z.string().default(''),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATA_DIR: z.string().default('./data'),
  LOG_DIR: z.string().default('./logs'),

  ALLOWED_PATHS: z.string().default(''),
  READONLY_PATHS: z.string().default(''),
  WRITABLE_PATHS: z.string().default(''),
  DENY_PATHS: z.string().default(''),
  APPROVED_SERVICES: z.string().default(''),
  APPROVED_GIT_REPOS: z.string().default(''),
  USE_SUDO: z
    .union([z.literal('true'), z.literal('false'), z.literal('auto')])
    .default('auto'),
  SHELL_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SHELL_KILL_GRACE_MS: z.coerce.number().int().positive().default(5_000),
  APPROVAL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  DB_PROFILES: z.string().default(''),
  DB_QUERY_MAX_ROWS: z.coerce.number().int().positive().max(10_000).default(1_000),
  DB_QUERY_DEFAULT_LIMIT: z.coerce.number().int().positive().max(10_000).default(100),
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  BT_PANEL_URL: z.string().default(''),
  BT_API_KEY: z.string().default(''),
  BT_API_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  BT_TLS_INSECURE: z.union([z.literal('true'), z.literal('false')]).default('false'),

  WATCHDOG_ENABLED: z.union([z.literal('true'), z.literal('false')]).default('true'),
  WATCHDOG_INTERVAL_SEC: z.coerce.number().int().positive().default(60),
  WATCHDOG_DISK_THRESHOLD: z.coerce.number().int().min(1).max(99).default(90),
  WATCHDOG_MEM_THRESHOLD: z.coerce.number().int().min(1).max(99).default(90),
  WATCHDOG_LOAD_MULTIPLIER: z.coerce.number().positive().default(4),
  WATCHDOG_URLS: z.string().default(''),
  WATCHDOG_DEDUP_MINUTES: z.coerce.number().int().positive().default(30),
  WATCHDOG_AUDIT_DENY_THRESHOLD: z.coerce.number().int().nonnegative().default(10),
  TELEGRAM_ALERT_USER_IDS: z.string().default(''),
});

interface DbProfile {
  name: string;
  driver: 'mysql' | 'postgres';
  dsn: string;
}

function parseDbProfiles(raw: string): DbProfile[] {
  if (!raw.trim()) return [];
  const out: DbProfile[] = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const sep = entry.indexOf(':');
    if (sep <= 0) continue;
    const name = entry.slice(0, sep).trim();
    const dsn = entry.slice(sep + 1).trim();
    let driver: DbProfile['driver'];
    if (dsn.startsWith('mysql://') || dsn.startsWith('mariadb://')) {
      driver = 'mysql';
    } else if (dsn.startsWith('postgres://') || dsn.startsWith('postgresql://')) {
      driver = 'postgres';
    } else {
      continue;
    }
    if (!name || /[^a-zA-Z0-9_-]/.test(name)) continue;
    out.push({ name, driver, dsn });
  }
  return out;
}

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Config validation failed:');
  for (const issue of parsed.error.issues) {
    console.error(` - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}
const env = parsed.data;

const dataDir = path.resolve(env.DATA_DIR);
const logDir = path.resolve(env.LOG_DIR);
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

// Files / dirs the agent must never read or write, regardless of ALLOWED_PATHS.
// Protects: agent's own secrets, session db, system credential stores.
const defaultDenyPaths = [
  path.resolve('.env'),
  path.resolve('.env.local'),
  path.resolve('.env.production'),
  dataDir,
  '/etc/shadow',
  '/etc/sudoers',
  '/etc/sudoers.d',
  '/root/.ssh',
];
const userDenyPaths = csv(env.DENY_PATHS).map((p) => path.resolve(p));
const denyPaths = Array.from(new Set([...defaultDenyPaths, ...userDenyPaths]));

export const config = {
  llm: {
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL.replace(/\/+$/, ''),
    model: env.LLM_MODEL,
    appName: env.OPENROUTER_APP_NAME,
    referer: env.OPENROUTER_HTTP_REFERER,
    maxTokens: env.LLM_MAX_TOKENS,
    contextBudget: env.LLM_CONTEXT_BUDGET,
    compactThreshold: env.LLM_COMPACT_THRESHOLD,
  },
  telegram: {
    token: env.TELEGRAM_BOT_TOKEN,
    allowedUserIds: new Set(csvNumbers(env.TELEGRAM_ALLOWED_USER_IDS)),
  },
  runtime: {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    dataDir,
    logDir,
    dbPath: path.join(dataDir, 'agent.db'),
  },
  tools: {
    allowedPaths: csv(env.ALLOWED_PATHS).map((p) => path.resolve(p)),
    readonlyPaths: csv(env.READONLY_PATHS).map((p) => path.resolve(p)),
    writablePaths: csv(env.WRITABLE_PATHS).map((p) => path.resolve(p)),
    denyPaths,
    approvedServices: csv(env.APPROVED_SERVICES),
    approvedGitRepos: csv(env.APPROVED_GIT_REPOS).map((p) => path.resolve(p)),
    useSudo:
      env.USE_SUDO === 'true' ? true : env.USE_SUDO === 'false' ? false : process.getuid?.() !== 0,
    shellTimeoutMs: env.SHELL_TIMEOUT_MS,
    shellKillGraceMs: env.SHELL_KILL_GRACE_MS,
    approvalTimeoutMs: env.APPROVAL_TIMEOUT_MS,
  },
  db: {
    profiles: parseDbProfiles(env.DB_PROFILES),
    maxRows: env.DB_QUERY_MAX_ROWS,
    defaultLimit: env.DB_QUERY_DEFAULT_LIMIT,
    timeoutMs: env.DB_QUERY_TIMEOUT_MS,
  },
  bt: {
    panelUrl: env.BT_PANEL_URL.replace(/\/+$/, ''),
    apiKey: env.BT_API_KEY,
    timeoutMs: env.BT_API_TIMEOUT_MS,
    tlsInsecure: env.BT_TLS_INSECURE === 'true',
    enabled: env.BT_PANEL_URL.length > 0 && env.BT_API_KEY.length > 0,
  },
  watchdog: {
    enabled: env.WATCHDOG_ENABLED === 'true',
    intervalSec: env.WATCHDOG_INTERVAL_SEC,
    diskThreshold: env.WATCHDOG_DISK_THRESHOLD,
    memThreshold: env.WATCHDOG_MEM_THRESHOLD,
    loadMultiplier: env.WATCHDOG_LOAD_MULTIPLIER,
    urls: csv(env.WATCHDOG_URLS),
    dedupMinutes: env.WATCHDOG_DEDUP_MINUTES,
    auditDenyThreshold: env.WATCHDOG_AUDIT_DENY_THRESHOLD,
    alertUserIds:
      csvNumbers(env.TELEGRAM_ALERT_USER_IDS).length > 0
        ? new Set(csvNumbers(env.TELEGRAM_ALERT_USER_IDS))
        : new Set(csvNumbers(env.TELEGRAM_ALLOWED_USER_IDS)),
  },
} as const;

export type { DbProfile };

export type Config = typeof config;
