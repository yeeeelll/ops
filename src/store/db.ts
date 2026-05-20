import Database from 'better-sqlite3';
import { config } from '../config.js';
import { logger } from '../logger.js';

export const db = new Database(config.runtime.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  channel      TEXT NOT NULL,
  external_id  TEXT,
  model        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_channel_ext
  ON sessions(channel, external_id);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL,
  tool_calls   TEXT,
  tool_call_id TEXT,
  name         TEXT,
  reasoning_content TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session
  ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT,
  tool            TEXT NOT NULL,
  args            TEXT NOT NULL,
  result          TEXT,
  status          TEXT NOT NULL,
  duration_ms     INTEGER,
  approval        TEXT,
  approval_reason TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_session
  ON audit_log(session_id, id);
`;

db.exec(SCHEMA);

function ensureColumn(table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    logger.info({ table, column }, 'SQLite column added');
  }
}

ensureColumn('messages', 'reasoning_content', 'TEXT');
ensureColumn('audit_log', 'approval', 'TEXT');
ensureColumn('audit_log', 'approval_reason', 'TEXT');

logger.info({ path: config.runtime.dbPath }, 'SQLite ready');

export function now(): number {
  return Date.now();
}
