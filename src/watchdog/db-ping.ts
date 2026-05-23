import type { DbProfile } from '../config.js';

const PING_TIMEOUT_MS = 5_000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run SELECT 1 against a profile to verify reachability. Uses a one-shot
 * connection to avoid keeping a pool open in the watchdog process.
 */
export async function runPing(profile: DbProfile): Promise<void> {
  if (profile.driver === 'mysql') {
    const { createConnection } = await import('mysql2/promise');
    const conn = await withTimeout(
      createConnection({ uri: profile.dsn, connectTimeout: PING_TIMEOUT_MS }),
      PING_TIMEOUT_MS,
      'mysql connect',
    );
    try {
      await withTimeout(conn.query('SELECT 1'), PING_TIMEOUT_MS, 'mysql query');
    } finally {
      await conn.end();
    }
  } else {
    const { Client } = await import('pg');
    const client = new Client({
      connectionString: profile.dsn,
      connectionTimeoutMillis: PING_TIMEOUT_MS,
      statement_timeout: PING_TIMEOUT_MS,
    });
    await withTimeout(client.connect(), PING_TIMEOUT_MS, 'pg connect');
    try {
      await withTimeout(client.query('SELECT 1'), PING_TIMEOUT_MS, 'pg query');
    } finally {
      await client.end();
    }
  }
}
