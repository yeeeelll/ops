import { randomUUID } from 'node:crypto';
import { Markup, type Telegraf, type Context } from 'telegraf';
import { callbackQuery } from 'telegraf/filters';
import { logger } from '../logger.js';
import { escapeHtml } from './format.js';
import type { ApprovalProvider, ApprovalRequest, ApprovalResult } from '../agent/approval.js';

interface PendingRequest {
  chatId: number;
  resolve: (result: ApprovalResult) => void;
  timer: NodeJS.Timeout;
  messageId: number;
  requestedBy: number;
}

const pending = new Map<string, PendingRequest>();

export class TelegramApprovalProvider implements ApprovalProvider {
  constructor(
    private readonly bot: Telegraf,
    private readonly resolveChatId: (sessionId: string) => number | null,
  ) {}

  async ask(req: ApprovalRequest): Promise<ApprovalResult> {
    const chatId = this.resolveChatId(req.sessionId);
    if (!chatId) {
      return { decision: 'denied', reason: 'no telegram chat for session' };
    }
    const reqId = randomUUID().slice(0, 12);
    const detailBlock = req.details
      ? `\n<pre>${escapeHtml(req.details.slice(0, 1500))}</pre>`
      : '';
    const text =
      `<b>[审批] ${escapeHtml(req.toolName)}</b>\n${escapeHtml(req.summary)}${detailBlock}\n\n` +
      `<i>${Math.round(req.timeoutMs / 1000)}s 内无操作将自动拒绝</i>`;

    const msg = await this.bot.telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        Markup.button.callback('✅ 确认', `appr:y:${reqId}`),
        Markup.button.callback('❌ 拒绝', `appr:n:${reqId}`),
      ]),
    });

    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(async () => {
        pending.delete(reqId);
        try {
          await this.bot.telegram.editMessageText(
            chatId,
            msg.message_id,
            undefined,
            `${text}\n\n<b>超时, 已拒绝</b>`,
            { parse_mode: 'HTML' },
          );
        } catch (err) {
          logger.debug({ err }, 'edit timeout msg failed');
        }
        resolve({ decision: 'timeout', reason: `no response within ${req.timeoutMs}ms` });
      }, req.timeoutMs);

      pending.set(reqId, {
        chatId,
        resolve,
        timer,
        messageId: msg.message_id,
        requestedBy: chatId,
      });
    });
  }
}

export function attachApprovalHandlers(bot: Telegraf, allowedUserIds: Set<number>): void {
  bot.on(callbackQuery('data'), async (ctx: Context) => {
    const data =
      ctx.callbackQuery && 'data' in ctx.callbackQuery
        ? (ctx.callbackQuery.data ?? '')
        : '';
    const uid = ctx.from?.id;
    logger.info({ data, uid, pendingSize: pending.size }, 'callback_query received');
    if (!data.startsWith('appr:')) return;
    const parts = data.split(':');
    const verdict = parts[1];
    const reqId = parts[2];
    if (!reqId) return;

    if (!uid || !allowedUserIds.has(uid)) {
      await ctx.answerCbQuery('未授权');
      return;
    }

    const req = pending.get(reqId);
    if (!req) {
      logger.warn({ reqId, pendingKeys: [...pending.keys()] }, 'callback for unknown reqId');
      await ctx.answerCbQuery('请求已过期');
      return;
    }

    pending.delete(reqId);
    clearTimeout(req.timer);

    const approved = verdict === 'y';
    req.resolve({
      decision: approved ? 'approved' : 'denied',
      reason: approved ? undefined : `denied by user ${uid}`,
    });

    await ctx.answerCbQuery(approved ? '已确认' : '已拒绝');
    try {
      const cq = ctx.callbackQuery;
      const existing =
        cq && cq.message && 'text' in cq.message ? cq.message.text : '';
      await ctx.editMessageText(
        `${existing}\n\n<b>${approved ? '已确认' : '已拒绝'}</b> by ${uid}`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      logger.debug({ err }, 'edit decision msg failed');
    }
  });
}
