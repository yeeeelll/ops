import { db, now } from './db.js';

const insertAudit = db.prepare(
  `INSERT INTO audit_log(session_id, tool, args, result, status, duration_ms, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

export interface AuditEntry {
  sessionId: string | null;
  tool: string;
  args: unknown;
  result: string | null;
  status: 'ok' | 'error' | 'denied';
  durationMs: number;
}

export function audit(entry: AuditEntry): void {
  insertAudit.run(
    entry.sessionId,
    entry.tool,
    JSON.stringify(entry.args),
    entry.result,
    entry.status,
    entry.durationMs,
    now(),
  );
}
