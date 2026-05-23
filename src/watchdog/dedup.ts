import { db } from '../store/db.js';
import type { AlertResult } from './types.js';

interface AlertRow {
  fingerprint: string;
  severity: string;
  last_sent_at: number;
  first_seen_at: number;
  hit_count: number;
  last_message: string;
}

const SELECT_BY_FP = db.prepare<[string]>(
  'SELECT * FROM alerts WHERE fingerprint = ?',
);

const UPSERT_NEW = db.prepare<[string, string, number, number, string]>(`
  INSERT INTO alerts (fingerprint, severity, last_sent_at, first_seen_at, hit_count, last_message)
  VALUES (?, ?, ?, ?, 1, ?)
  ON CONFLICT(fingerprint) DO UPDATE SET
    severity     = excluded.severity,
    last_sent_at = excluded.last_sent_at,
    hit_count    = alerts.hit_count + 1,
    last_message = excluded.last_message
`);

const UPDATE_HIT_NO_SEND = db.prepare<[string]>(
  'UPDATE alerts SET hit_count = hit_count + 1 WHERE fingerprint = ?',
);

export interface DedupDecision {
  shouldSend: boolean;
  isFirst: boolean;
  hitCount: number;
}

/**
 * Decide whether to send this alert based on dedup window. Updates the
 * alerts table accordingly.
 */
export function recordAndDecide(
  alert: AlertResult,
  dedupWindowMs: number,
  now: number,
): DedupDecision {
  const existing = SELECT_BY_FP.get(alert.fingerprint) as AlertRow | undefined;
  if (!existing) {
    UPSERT_NEW.run(alert.fingerprint, alert.severity, now, now, alert.message);
    return { shouldSend: true, isFirst: true, hitCount: 1 };
  }
  const elapsed = now - existing.last_sent_at;
  if (elapsed >= dedupWindowMs) {
    UPSERT_NEW.run(alert.fingerprint, alert.severity, now, existing.first_seen_at, alert.message);
    return { shouldSend: true, isFirst: false, hitCount: existing.hit_count + 1 };
  }
  UPDATE_HIT_NO_SEND.run(alert.fingerprint);
  return { shouldSend: false, isFirst: false, hitCount: existing.hit_count + 1 };
}

const CLEAR_BY_FP = db.prepare<[string]>('DELETE FROM alerts WHERE fingerprint = ?');

/** Mark an alert as resolved (clears row so next occurrence sends fresh). */
export function clearAlert(fingerprint: string): void {
  CLEAR_BY_FP.run(fingerprint);
}
