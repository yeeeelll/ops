import type { Telegraf } from 'telegraf';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { ALL_CHECKS } from './checks.js';
import { recordAndDecide } from './dedup.js';
import { sendAlert } from './notify.js';
import type { AlertResult } from './types.js';

export interface WatchdogHandle {
  stop(): void;
}

async function runOnce(bot: Telegraf): Promise<void> {
  const collected: AlertResult[] = [];
  for (const check of ALL_CHECKS) {
    try {
      const results = await check.run();
      collected.push(...results);
    } catch (err) {
      logger.error({ err, check: check.name }, 'watchdog check threw');
    }
  }

  if (collected.length === 0) return;

  const dedupWindowMs = config.watchdog.dedupMinutes * 60 * 1000;
  const now = Date.now();

  for (const alert of collected) {
    const decision = recordAndDecide(alert, dedupWindowMs, now);
    if (!decision.shouldSend) {
      logger.debug(
        { fp: alert.fingerprint, hits: decision.hitCount },
        'watchdog alert suppressed by dedup',
      );
      continue;
    }
    await sendAlert({
      bot,
      alert,
      hitCount: decision.hitCount,
      isFirst: decision.isFirst,
    });
  }
}

export function startWatchdog(bot: Telegraf): WatchdogHandle {
  if (!config.watchdog.enabled) {
    logger.warn('watchdog disabled by WATCHDOG_ENABLED=false');
    return { stop: () => undefined };
  }
  if (config.watchdog.alertUserIds.size === 0) {
    logger.warn('watchdog enabled but no alert recipients (TELEGRAM_ALERT_USER_IDS / TELEGRAM_ALLOWED_USER_IDS both empty) — disabling');
    return { stop: () => undefined };
  }

  const intervalMs = config.watchdog.intervalSec * 1_000;
  logger.warn(
    {
      intervalSec: config.watchdog.intervalSec,
      checks: ALL_CHECKS.map((c) => c.name),
      recipients: [...config.watchdog.alertUserIds],
    },
    'watchdog starting',
  );

  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await runOnce(bot);
    } catch (err) {
      logger.error({ err }, 'watchdog runOnce failed');
    } finally {
      running = false;
    }
  };

  // First tick after a short delay so bot can finish booting.
  const initial = setTimeout(() => void tick(), 5_000);
  const handle = setInterval(() => void tick(), intervalMs);

  return {
    stop() {
      stopped = true;
      clearTimeout(initial);
      clearInterval(handle);
    },
  };
}
