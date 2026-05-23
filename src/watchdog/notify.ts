import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { escapeHtml } from '../adapters/format.js';
import type { AlertResult, AlertSeverity } from './types.js';

const SEVERITY_ICON: Record<AlertSeverity, string> = {
  info: 'i',
  warning: 'WARN',
  critical: 'CRIT',
};

interface SendAlertArgs {
  bot: Telegraf;
  alert: AlertResult;
  hitCount: number;
  isFirst: boolean;
}

export async function sendAlert({ bot, alert, hitCount, isFirst }: SendAlertArgs): Promise<void> {
  const recipients = config.watchdog.alertUserIds;
  if (recipients.size === 0) {
    logger.warn('watchdog has alerts but no recipient user ids configured');
    return;
  }
  const sev = SEVERITY_ICON[alert.severity];
  const repeat = isFirst ? '' : ` (×${hitCount})`;
  const text =
    `[${sev}] <b>${escapeHtml(alert.title)}</b>${repeat}\n` +
    `<pre>${escapeHtml(alert.message.slice(0, 1500))}</pre>`;

  const keyboard = Markup.inlineKeyboard([
    Markup.button.callback('让 agent 调查', `alert:inv:${alert.fingerprint}`),
    Markup.button.callback('解除', `alert:clr:${alert.fingerprint}`),
  ]);

  for (const uid of recipients) {
    try {
      await bot.telegram.sendMessage(uid, text, { parse_mode: 'HTML', ...keyboard });
    } catch (err) {
      logger.warn({ err, uid }, 'failed to send watchdog alert');
    }
  }
}
