import { randomUUID } from 'node:crypto';
import { db, now } from './db.js';
import type { ChatMessage } from '../agent/types.js';

export interface SessionRow {
  id: string;
  channel: string;
  externalId: string | null;
  model: string;
  createdAt: number;
  updatedAt: number;
}

const insertSession = db.prepare(
  `INSERT INTO sessions(id, channel, external_id, model, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

const findByExternal = db.prepare(
  `SELECT id, channel, external_id AS externalId, model,
          created_at AS createdAt, updated_at AS updatedAt
     FROM sessions
    WHERE channel = ? AND external_id = ?
    LIMIT 1`,
);

const touchSession = db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`);

const updateModelStmt = db.prepare(`UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?`);

const getSessionStmt = db.prepare(
  `SELECT id, channel, external_id AS externalId, model,
          created_at AS createdAt, updated_at AS updatedAt
     FROM sessions WHERE id = ? LIMIT 1`,
);

const insertMessage = db.prepare(
  `INSERT INTO messages(session_id, role, content, tool_calls, tool_call_id, name, reasoning_content, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);

const loadMessages = db.prepare(
  `SELECT role, content, tool_calls AS toolCalls, tool_call_id AS toolCallId, name,
          reasoning_content AS reasoningContent
     FROM messages WHERE session_id = ? ORDER BY id ASC`,
);

export function getOrCreateSession(
  channel: string,
  externalId: string | null,
  model: string,
): SessionRow {
  if (externalId) {
    const found = findByExternal.get(channel, externalId) as SessionRow | undefined;
    if (found) return found;
  }
  const id = randomUUID();
  const ts = now();
  insertSession.run(id, channel, externalId, model, ts, ts);
  return { id, channel, externalId, model, createdAt: ts, updatedAt: ts };
}

export function appendMessage(sessionId: string, msg: ChatMessage): void {
  insertMessage.run(
    sessionId,
    msg.role,
    typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
    msg.tool_call_id ?? null,
    msg.name ?? null,
    msg.reasoning_content ?? null,
    now(),
  );
  touchSession.run(now(), sessionId);
}

export function getSession(sessionId: string): SessionRow | null {
  const row = getSessionStmt.get(sessionId) as SessionRow | undefined;
  return row ?? null;
}

export function setSessionModel(sessionId: string, model: string): void {
  updateModelStmt.run(model, now(), sessionId);
}

export function loadHistory(sessionId: string): ChatMessage[] {
  const rows = loadMessages.all(sessionId) as Array<{
    role: ChatMessage['role'];
    content: string;
    toolCalls: string | null;
    toolCallId: string | null;
    name: string | null;
    reasoningContent: string | null;
  }>;
  return rows.map((r) => ({
    role: r.role,
    content: r.content,
    ...(r.toolCalls ? { tool_calls: JSON.parse(r.toolCalls) } : {}),
    ...(r.toolCallId ? { tool_call_id: r.toolCallId } : {}),
    ...(r.name ? { name: r.name } : {}),
    ...(r.reasoningContent ? { reasoning_content: r.reasoningContent } : {}),
  }));
}
