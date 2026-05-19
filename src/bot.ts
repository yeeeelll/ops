import { config } from './config.js';
import { logger } from './logger.js';
import './tools/index.js';
import { listToolNames } from './tools/registry.js';
import { buildBot } from './adapters/telegram.js';
import { preloadModels } from './adapters/commands.js';

async function main(): Promise<void> {
  if (!config.telegram.token) {
    logger.fatal('TELEGRAM_BOT_TOKEN 未配置, 无法启动 bot');
    process.exit(1);
  }
  if (config.telegram.allowedUserIds.size === 0) {
    logger.fatal('TELEGRAM_ALLOWED_USER_IDS 为空, 拒绝启动无白名单 bot');
    process.exit(1);
  }

  void preloadModels();

  const bot = buildBot();

  process.once('SIGINT', () => {
    logger.info('SIGINT received, stopping bot');
    bot.stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    logger.info('SIGTERM received, stopping bot');
    bot.stop('SIGTERM');
  });

  logger.warn(
    {
      tools: listToolNames(),
      allowedUsers: [...config.telegram.allowedUserIds],
      defaultModel: config.llm.model,
    },
    'Telegram bot starting',
  );

  await bot.launch({
    dropPendingUpdates: true,
  });

  logger.warn('Telegram bot stopped');
}

main().catch((err) => {
  logger.fatal({ err }, 'bot crashed');
  process.exit(1);
});
