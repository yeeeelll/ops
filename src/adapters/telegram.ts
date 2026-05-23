import { Telegraf, type Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { runTurn } from '../agent/loop.js';
import { getOrCreateSession, getSession } from '../store/session.js';
import { handleCommand, isCommand } from './commands.js';
import { asPlainBlock, escapeHtml, splitMessage, trimForEdit } from './format.js';
import { registerApprovalProvider } from '../agent/approval.js';
import { attachApprovalHandlers, TelegramApprovalProvider } from './approval-telegram.js';
import { attachAlertHandlers } from './alert-callback.js';

const CHANNEL = 'telegram';
const EDIT_THROTTLE_MS = 1100;

const busy = new Map<number, boolean>();

function chatIdForSession(sessionId: string): number | null {
  const sess = getSession(sessionId);
  if (!sess || sess.channel !== CHANNEL || !sess.externalId) return null;
  const n = Number(sess.externalId);
  return Number.isFinite(n) ? n : null;
}

export function buildBot(): Telegraf {
  const bot = new Telegraf(config.telegram.token);

  registerApprovalProvider(CHANNEL, new TelegramApprovalProvider(bot, chatIdForSession));
  attachApprovalHandlers(bot, config.telegram.allowedUserIds);
  attachAlertHandlers(bot, config.telegram.allowedUserIds, (ctx, prompt) => {
    void runAgentTurn(ctx, prompt).catch((err) =>
      logger.error({ err, uid: ctx.from?.id }, 'alert-triggered turn crashed'),
    );
  });

  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (!uid || !config.telegram.allowedUserIds.has(uid)) {
      logger.warn({ uid, name: ctx.from?.username }, 'telegram unauthorized');
      if (ctx.chat) {
        try {
          await ctx.reply('未授权用户。请联系管理员将你的 Telegram ID 加入白名单。');
        } catch {
          /* noop */
        }
      }
      return;
    }
    return next();
  });

  bot.start(async (ctx) => {
    sessionFor(ctx);
    await ctx.reply(
      [
        '运维 Agent 已就绪。',
        '直接发消息开始对话, 输入 /help 查看命令。',
      ].join('\n'),
    );
  });

  bot.command('help', async (ctx) => runSlashCommand(ctx, 'help', []));
  bot.command('model', async (ctx) => runSlashCommand(ctx, 'model', parseArgs(ctx)));
  bot.command('new', async (ctx) => runSlashCommand(ctx, 'new', []));
  bot.command('session', async (ctx) => runSlashCommand(ctx, 'session', []));
  bot.command('quit', async (ctx) =>
    ctx.reply('Bot 进程在服务器上运行, 无法从对话退出。如需停止请联系管理员。'),
  );

  bot.on(message('text'), async (ctx) => {
    const text = ctx.message.text;
    if (isCommand(text)) {
      const stripped = text.trim().replace(/^[/:]+/, '');
      const parts = stripped.split(/\s+/);
      const name = (parts[0] ?? '').toLowerCase();
      const args = parts.slice(1);
      void runSlashCommand(ctx, name, args).catch((err) =>
        logger.error({ err, name }, 'slash command crashed'),
      );
      return;
    }
    void runAgentTurn(ctx, text).catch((err) =>
      logger.error({ err, uid: ctx.from?.id }, 'agent turn crashed'),
    );
  });

  bot.catch((err, ctx) => {
    logger.error({ err, update: ctx.update }, 'telegraf middleware error');
  });

  return bot;
}

function sessionFor(ctx: Context) {
  const uid = ctx.from!.id;
  return getOrCreateSession(CHANNEL, String(uid), config.llm.model);
}

function parseArgs(ctx: Context): string[] {
  const text =
    ctx.message && 'text' in ctx.message && typeof ctx.message.text === 'string'
      ? ctx.message.text
      : '';
  const parts = text.trim().split(/\s+/);
  return parts.slice(1);
}

async function runSlashCommand(ctx: Context, name: string, args: string[]): Promise<void> {
  const sess = sessionFor(ctx);
  try {
    const result = await handleCommand(`/${name} ${args.join(' ')}`.trim(), {
      channel: CHANNEL,
      sessionId: sess.id,
    });
    await replyLong(ctx, result.text);
  } catch (err) {
    logger.error({ err, name }, 'command failed');
    await ctx.reply(`命令错误: ${(err as Error).message}`);
  }
}

async function runAgentTurn(ctx: Context, userInput: string): Promise<void> {
  const uid = ctx.from!.id;
  if (busy.get(uid)) {
    await ctx.reply('上一条还没处理完, 请稍后再试。');
    return;
  }
  busy.set(uid, true);

  const sess = sessionFor(ctx);
  const progress = await ctx.reply('思考中…');
  const chatId = progress.chat.id;
  const messageId = progress.message_id;

  let progressText = '思考中…';
  let lastEditAt = 0;
  let pending = false;
  let toolCount = 0;
  let modelMismatch: string | null = null;

  const flushProgress = async (force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastEditAt < EDIT_THROTTLE_MS) {
      if (!pending) {
        pending = true;
        setTimeout(() => {
          pending = false;
          void flushProgress(true);
        }, EDIT_THROTTLE_MS - (now - lastEditAt));
      }
      return;
    }
    lastEditAt = Date.now();
    try {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, trimForEdit(progressText));
    } catch (err) {
      logger.debug({ err }, 'edit message failed (likely same content)');
    }
  };

  /** Single-line progress, overwrites prior state (no scroll spam). */
  const setProgress = (line: string): void => {
    progressText = line;
    void flushProgress();
  };

  try {
    const result = await runTurn({
      sessionId: sess.id,
      channel: CHANNEL,
      userInput,
      onToolStart: (call) => {
        toolCount += 1;
        const argsRaw = call.function.arguments ?? '';
        const argsShort = argsRaw.replace(/\s+/g, ' ').slice(0, 80);
        setProgress(`思考中… 调用第 ${toolCount} 个工具: ${call.function.name}\n${argsShort}`);
      },
      onToolEnd: (call, ok) => {
        setProgress(
          `思考中… 第 ${toolCount} 个工具 ${call.function.name} ${ok ? '已完成' : '失败'}`,
        );
      },
      onCompletion: ({ requestedModel, servedModel }) => {
        if (servedModel !== requestedModel && !servedModel.startsWith(`${requestedModel}-`)) {
          modelMismatch = `模型不匹配: 请求=${requestedModel} 实际=${servedModel}`;
        }
      },
    });

    const finalText = result.finalText || '(无回复)';
    const chunks = splitMessage(finalText);

    if (toolCount === 0) {
      // Pure-chat reply, no tool calls — edit the progress bubble directly,
      // no extra message in the chat scroll.
      try {
        await ctx.telegram.editMessageText(chatId, messageId, undefined, chunks[0]!);
      } catch (err) {
        logger.warn({ err }, 'final edit failed, sending as new message');
        await ctx.reply(chunks[0]!);
      }
    } else {
      // After tool calls (some may have shown approval popups in between),
      // collapse the progress bubble into a short summary and send the
      // actual answer as a fresh message at the bottom so the user doesn't
      // have to scroll up past the approval messages to find it.
      const summary = `已完成 (用了 ${toolCount} 次工具调用)${
        modelMismatch ? `\n[${modelMismatch}]` : ''
      }`;
      try {
        await ctx.telegram.editMessageText(chatId, messageId, undefined, summary);
      } catch (err) {
        logger.debug({ err }, 'collapse progress edit failed');
      }
      await ctx.reply(chunks[0]!);
    }
    for (const c of chunks.slice(1)) await ctx.reply(c);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, uid, sessionId: sess.id }, 'agent turn failed');
    try {
      await ctx.telegram.editMessageText(
        chatId,
        messageId,
        undefined,
        `处理失败:\n${asPlainBlock(escapeHtml(msg).slice(0, 1000))}`,
        { parse_mode: 'HTML' },
      );
    } catch {
      await ctx.reply(`处理失败: ${msg.slice(0, 500)}`);
    }
  } finally {
    busy.delete(uid);
  }
}

async function replyLong(ctx: Context, text: string): Promise<void> {
  const chunks = splitMessage(text);
  for (const c of chunks) await ctx.reply(c);
}
