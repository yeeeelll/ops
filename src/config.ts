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
  APPROVED_SERVICES: z.string().default(''),
  APPROVED_GIT_REPOS: z.string().default(''),
  SHELL_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SHELL_KILL_GRACE_MS: z.coerce.number().int().positive().default(5_000),
  APPROVAL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
});

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
    approvedServices: csv(env.APPROVED_SERVICES),
    approvedGitRepos: csv(env.APPROVED_GIT_REPOS).map((p) => path.resolve(p)),
    shellTimeoutMs: env.SHELL_TIMEOUT_MS,
    shellKillGraceMs: env.SHELL_KILL_GRACE_MS,
    approvalTimeoutMs: env.APPROVAL_TIMEOUT_MS,
  },
} as const;

export type Config = typeof config;
