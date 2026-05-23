import os from 'node:os';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import { config } from '../config.js';
import { db } from '../store/db.js';
import { logger } from '../logger.js';
import type { AlertResult, Check } from './types.js';

const SYSTEMCTL_TIMEOUT_MS = 5_000;

/**
 * Strip a glob suffix like "php-fpm*" -> "php-fpm". For watchdog we can only
 * check exact unit names, so prefix patterns are dropped with a warning.
 */
function expandUnitName(raw: string): string | null {
  if (raw.includes('*')) return null;
  return raw;
}

const systemdCheck: Check = {
  name: 'systemd',
  async run() {
    const alerts: AlertResult[] = [];
    for (const raw of config.tools.approvedServices) {
      const unit = expandUnitName(raw);
      if (!unit) continue;
      try {
        const proc = await execa('systemctl', ['is-active', unit], {
          timeout: SYSTEMCTL_TIMEOUT_MS,
          reject: false,
        });
        const state = (proc.stdout ?? '').trim();
        if (state !== 'active') {
          alerts.push({
            fingerprint: `systemd:${unit}`,
            severity: state === 'failed' ? 'critical' : 'warning',
            title: `systemd unit ${unit} is ${state || 'inactive'}`,
            message:
              `${unit}: ${state || '(no state)'}\n` +
              `journalctl -u ${unit} -n 30 --no-pager`,
          });
        }
      } catch (err) {
        logger.debug({ err, unit }, 'systemctl is-active failed');
      }
    }
    return alerts;
  },
};

interface DfLine {
  source: string;
  size: number;
  used: number;
  available: number;
  capacity: number;
  mount: string;
}

function parseDfPosix(stdout: string): DfLine[] {
  // df -P output: Filesystem 1024-blocks Used Available Capacity Mounted on
  const lines = stdout.trim().split('\n').slice(1);
  const out: DfLine[] = [];
  for (const ln of lines) {
    const cols = ln.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const source = cols[0] ?? '';
    const mount = cols.slice(5).join(' ');
    if (
      source === 'tmpfs' ||
      source === 'devtmpfs' ||
      source === 'overlay' ||
      source.startsWith('udev')
    ) {
      continue;
    }
    const capStr = cols[4] ?? '';
    const capacity = Number(capStr.replace('%', ''));
    if (!Number.isFinite(capacity)) continue;
    out.push({
      source,
      size: Number(cols[1]) || 0,
      used: Number(cols[2]) || 0,
      available: Number(cols[3]) || 0,
      capacity,
      mount,
    });
  }
  return out;
}

const diskCheck: Check = {
  name: 'disk',
  async run() {
    const alerts: AlertResult[] = [];
    try {
      const proc = await execa('df', ['-P'], {
        timeout: 5_000,
        reject: false,
      });
      if (proc.failed) return alerts;
      const rows = parseDfPosix(proc.stdout ?? '');
      for (const r of rows) {
        if (r.capacity >= config.watchdog.diskThreshold) {
          alerts.push({
            fingerprint: `disk:${r.mount}`,
            severity: r.capacity >= 95 ? 'critical' : 'warning',
            title: `disk ${r.mount} ${r.capacity}% full`,
            message:
              `mount: ${r.mount} (${r.source})\n` +
              `usage: ${r.capacity}% (${r.used} / ${r.size} blocks, ${r.available} free)`,
          });
        }
      }
    } catch (err) {
      logger.debug({ err }, 'disk check failed');
    }
    return alerts;
  },
};

const memoryCheck: Check = {
  name: 'memory',
  async run() {
    const alerts: AlertResult[] = [];
    try {
      const text = await fs.readFile('/proc/meminfo', 'utf8');
      const numbers = new Map<string, number>();
      for (const line of text.split('\n')) {
        const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
        if (m && m[1] && m[2]) numbers.set(m[1], Number(m[2]));
      }
      const total = numbers.get('MemTotal');
      const available = numbers.get('MemAvailable');
      if (total && available) {
        const usedPct = Math.round(((total - available) / total) * 100);
        if (usedPct >= config.watchdog.memThreshold) {
          alerts.push({
            fingerprint: 'memory:usage',
            severity: usedPct >= 95 ? 'critical' : 'warning',
            title: `memory ${usedPct}% used`,
            message:
              `MemTotal: ${total} kB\nMemAvailable: ${available} kB\nUsage: ${usedPct}%`,
          });
        }
      }
    } catch (err) {
      logger.debug({ err }, 'memory check failed (non-Linux?)');
    }
    return alerts;
  },
};

const loadCheck: Check = {
  name: 'load',
  async run() {
    const alerts: AlertResult[] = [];
    const loadavg = os.loadavg();
    const load1 = loadavg[0] ?? 0;
    const cpus = os.cpus().length || 1;
    const threshold = cpus * config.watchdog.loadMultiplier;
    if (load1 > threshold) {
      alerts.push({
        fingerprint: 'load:1min',
        severity: load1 > threshold * 1.5 ? 'critical' : 'warning',
        title: `load average ${load1.toFixed(2)} (${cpus} CPUs, threshold ${threshold.toFixed(1)})`,
        message: `loadavg: ${loadavg.map((n) => n.toFixed(2)).join(' / ')}\nCPUs: ${cpus}`,
      });
    }
    return alerts;
  },
};

const httpCheck: Check = {
  name: 'http',
  async run() {
    const alerts: AlertResult[] = [];
    const urls = config.watchdog.urls;
    if (urls.length === 0) return alerts;
    await Promise.all(
      urls.map(async (url) => {
        const fp = `http:${url}`;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          let resp: Response;
          try {
            resp = await fetch(url, {
              method: 'GET',
              signal: controller.signal,
              redirect: 'follow',
            });
          } finally {
            clearTimeout(timer);
          }
          if (resp.status >= 400) {
            alerts.push({
              fingerprint: fp,
              severity: resp.status >= 500 ? 'critical' : 'warning',
              title: `HTTP ${resp.status} on ${url}`,
              message: `URL: ${url}\nstatus: ${resp.status} ${resp.statusText}`,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          alerts.push({
            fingerprint: fp,
            severity: 'critical',
            title: `HTTP unreachable: ${url}`,
            message: `URL: ${url}\nerror: ${msg}`,
          });
        }
      }),
    );
    return alerts;
  },
};

const dbPingCheck: Check = {
  name: 'db_ping',
  async run() {
    const alerts: AlertResult[] = [];
    if (config.db.profiles.length === 0) return alerts;
    // Lazy import to keep watchdog cheap when no DB is configured.
    const { runPing } = await import('./db-ping.js');
    for (const profile of config.db.profiles) {
      try {
        await runPing(profile);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        alerts.push({
          fingerprint: `db_ping:${profile.name}`,
          severity: 'critical',
          title: `DB profile ${profile.name} unreachable`,
          message: `profile: ${profile.name} (${profile.driver})\nerror: ${msg}`,
        });
      }
    }
    return alerts;
  },
};

const auditCheck: Check = {
  name: 'audit',
  async run() {
    const alerts: AlertResult[] = [];
    const threshold = config.watchdog.auditDenyThreshold;
    if (threshold <= 0) return alerts;
    const since = Date.now() - 3_600_000;
    const row = db
      .prepare<[number]>(
        `SELECT COUNT(*) as n FROM audit_log
         WHERE created_at >= ?
           AND (status = 'denied' OR approval IN ('denied', 'timeout'))`,
      )
      .get(since) as { n: number } | undefined;
    const n = row?.n ?? 0;
    if (n >= threshold) {
      alerts.push({
        fingerprint: 'audit:denied_burst',
        severity: 'warning',
        title: `${n} denied/timeout tool calls in last hour`,
        message:
          `denied + timeout calls (1h): ${n}\n` +
          `threshold: ${threshold}\n` +
          `Possible prompt injection / abuse. Check audit_log and recent sessions.`,
      });
    }
    return alerts;
  },
};

export const ALL_CHECKS: Check[] = [
  systemdCheck,
  diskCheck,
  memoryCheck,
  loadCheck,
  httpCheck,
  dbPingCheck,
  auditCheck,
];
