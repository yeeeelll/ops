import readline from 'node:readline';
import { config } from './config.js';
import { logger } from './logger.js';
import './tools/index.js';
import { listToolNames } from './tools/registry.js';
import { getOrCreateSession } from './store/session.js';
import { runTurn } from './agent/loop.js';
import { handleCommand, isCommand, preloadModels } from './adapters/commands.js';

async function main(): Promise<void> {
  const session = getOrCreateSession('cli', process.env.USER ?? 'local', config.llm.model);
  logger.info(
    { sessionId: session.id, model: session.model, tools: listToolNames() },
    'CLI ready',
  );

  process.stdout.write(`\nAI 运维 Agent (CLI 模式)\n`);
  process.stdout.write(`会话=${session.id}  模型=${session.model}\n`);
  process.stdout.write(`可用工具=${listToolNames().join(', ')}\n`);
  process.stdout.write(`直接输入消息开始对话, 输入 /help 查看命令。\n\n`);

  void preloadModels();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let sessionId = session.id;

  const ask = (): Promise<void> =>
    new Promise((resolve) => {
      rl.question('you> ', async (line) => {
        const input = line.trim();
        if (!input) return resolve(ask());

        if (isCommand(input)) {
          try {
            const result = await handleCommand(input, { channel: 'cli', sessionId });
            process.stdout.write(`${result.text}\n\n`);
            if (result.newSessionId) sessionId = result.newSessionId;
            if (result.exit) {
              rl.close();
              return resolve();
            }
          } catch (err) {
            logger.error({ err }, 'command failed');
            process.stdout.write(`命令错误: ${(err as Error).message}\n\n`);
          }
          return resolve(ask());
        }

        try {
          const result = await runTurn({
            sessionId,
            channel: 'cli',
            userInput: input,
            onToolStart: (call) => {
              const argsStr =
                call.function.arguments.length > 120
                  ? `${call.function.arguments.slice(0, 117)}...`
                  : call.function.arguments;
              process.stdout.write(`  [tool] ${call.function.name} ${argsStr}\n`);
            },
            onToolEnd: (call, ok, preview) => {
              process.stdout.write(
                `  [tool] ${call.function.name} -> ${ok ? 'ok' : 'err'} | ${preview.replace(/\n/g, ' ')}\n`,
              );
            },
            onCompletion: ({ requestedModel, servedModel }) => {
              const mismatch =
                servedModel !== requestedModel && !servedModel.startsWith(`${requestedModel}-`);
              if (mismatch) {
                process.stdout.write(
                  `  [模型不匹配] 请求=${requestedModel} 实际=${servedModel}\n`,
                );
              }
            },
          });
          process.stdout.write(`\nagent> ${result.finalText}\n\n`);
        } catch (err) {
          logger.error({ err }, 'turn failed');
          process.stdout.write(`错误: ${(err as Error).message}\n\n`);
        }
        resolve(ask());
      });
    });

  await ask();
}

main().catch((err) => {
  logger.fatal({ err }, 'cli crashed');
  process.exit(1);
});
