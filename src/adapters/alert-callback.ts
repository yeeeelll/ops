import type { Context, Telegraf } from 'telegraf';
import { callbackQuery } from 'telegraf/filters';
import { db } from '../store/db.js';
import { logger } from '../logger.js';
import { clearAlert } from '../watchdog/dedup.js';

interface AlertRow {
  fingerprint: string;
  severity: string;
  last_message: string;
  hit_count: number;
}

const SELECT_FP = db.prepare<[string]>(
  'SELECT fingerprint, severity, last_message, hit_count FROM alerts WHERE fingerprint = ?',
);

type RunInvestigation = (ctx: Context, userInput: string) => void;

export function attachAlertHandlers(
  bot: Telegraf,
  allowedUserIds: Set<number>,
  runInvestigation: RunInvestigation,
): void {
  bot.on(callbackQuery('data'), async (ctx: Context, next) => {
    const data =
      ctx.callbackQuery && 'data' in ctx.callbackQuery
        ? (ctx.callbackQuery.data ?? '')
        : '';
    if (!data.startsWith('alert:')) return next();

    const uid = ctx.from?.id;
    if (!uid || !allowedUserIds.has(uid)) {
      await ctx.answerCbQuery('未授权');
      return;
    }

    const [, action, ...rest] = data.split(':');
    const fingerprint = rest.join(':');
    if (!fingerprint) {
      await ctx.answerCbQuery('无效');
      return;
    }

    if (action === 'clr') {
      clearAlert(fingerprint);
      await ctx.answerCbQuery('已解除');
      try {
        await ctx.editMessageReplyMarkup(undefined);
      } catch (err) {
        logger.debug({ err }, 'clear alert: edit markup failed');
      }
      return;
    }

    if (action === 'inv') {
      const row = SELECT_FP.get(fingerprint) as AlertRow | undefined;
      await ctx.answerCbQuery('开始调查…');
      const prompt = row
        ? [
            `服务器自动告警 (fingerprint=${row.fingerprint}, 命中 ${row.hit_count} 次, 严重度 ${row.severity}):`,
            row.last_message,
            '',
            '请用只读工具调查根因, 给出 1-3 条具体修复步骤。不要直接执行写操作。',
          ].join('\n')
        : `服务器自动告警: ${fingerprint} (告警详情已过期), 请帮我看一下当前服务器状态。`;
      runInvestigation(ctx, prompt);
      return;
    }

    await ctx.answerCbQuery('未知 alert 动作');
  });
}
