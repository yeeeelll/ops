import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import {
  budgetForModel,
  findModel,
  formatModelLine,
  listModels,
  searchModels,
} from '../agent/models.js';
import { getOrCreateSession, getSession, setSessionModel } from '../store/session.js';

export interface CommandContext {
  channel: string;
  sessionId: string;
}

export interface CommandResult {
  text: string;
  newSessionId?: string;
  exit?: boolean;
  clearScreen?: boolean;
}

export type CommandHandler = (args: string[], ctx: CommandContext) => Promise<CommandResult>;

const handlers: Record<string, CommandHandler> = {
  help: async () => ({
    text: [
      '可用命令:',
      '  /help              显示帮助',
      '  /quit  | /q        退出',
      '  /new               开启新会话',
      '  /clear             清屏并开启新会话 (Telegram 仅起新会话)',
      '  /model             显示当前模型',
      '  /model <id>        切换模型 (例: /model deepseek/deepseek-v4-pro)',
      '  /model list [关键字]   列出模型, 可加关键字过滤',
      '  /session           显示当前会话信息',
    ].join('\n'),
  }),

  quit: async () => ({ text: '再见。', exit: true }),
  q: async () => ({ text: '再见。', exit: true }),
  exit: async () => ({ text: '再见。', exit: true }),

  new: async (_, ctx) => {
    const sess = getOrCreateSession(
      ctx.channel,
      `${ctx.channel}-${Date.now()}-${randomUUID().slice(0, 6)}`,
      config.llm.model,
    );
    return {
      text: `已开启新会话\n  会话=${sess.id}\n  模型=${sess.model}`,
      newSessionId: sess.id,
    };
  },

  clear: async (_, ctx) => {
    const sess = getOrCreateSession(
      ctx.channel,
      `${ctx.channel}-${Date.now()}-${randomUUID().slice(0, 6)}`,
      config.llm.model,
    );
    return {
      text: `已清空并开启新会话\n  会话=${sess.id}\n  模型=${sess.model}`,
      newSessionId: sess.id,
      clearScreen: true,
    };
  },

  session: async (_, ctx) => {
    const s = getSession(ctx.sessionId);
    if (!s) return { text: `未找到会话 ${ctx.sessionId}` };
    const m = await findModel(s.model).catch(() => null);
    const ctxLen = m ? `${Math.round(m.contextLength / 1000)}K` : '未知';
    const budget = m ? budgetForModel(m) : config.llm.contextBudget;
    return {
      text: [
        `会话=${s.id}`,
        `通道=${s.channel}`,
        `模型=${s.model}  上下文=${ctxLen}  预算=${budget}`,
        `创建于=${new Date(s.createdAt).toISOString()}`,
      ].join('\n'),
    };
  },

  model: async (args, ctx) => {
    if (args.length === 0) {
      const s = getSession(ctx.sessionId);
      const cur = s?.model ?? config.llm.model;
      return {
        text: `当前模型: ${cur}\n  /model list 浏览全部, /model <id> 切换`,
      };
    }

    const sub = args[0]!;

    if (sub === 'list') {
      const q = args.slice(1).join(' ');
      const list = await searchModels(q, 50);
      if (list.length === 0) return { text: `没有模型匹配 "${q}"` };
      const header = q
        ? `匹配 "${q}" 的模型 (${list.length}):`
        : `前 ${list.length} 个模型:`;
      const body = list.map(formatModelLine).join('\n');
      return { text: `${header}\n${body}` };
    }

    const targetId = args.join(' ').trim();
    const model = await findModel(targetId);
    if (!model) {
      return {
        text: `未找到模型: ${targetId}\n  试试 /model list ${targetId.split('/')[0] ?? ''}`,
      };
    }
    setSessionModel(ctx.sessionId, model.id);
    const budget = budgetForModel(model);
    return {
      text: `已切换 -> ${model.id}\n  名称=${model.name}\n  上下文=${model.contextLength}  预算=${budget}  工具支持=${model.supportsTools}`,
    };
  },
};

export function isCommand(line: string): boolean {
  return line.startsWith('/') || line.startsWith(':');
}

export async function handleCommand(line: string, ctx: CommandContext): Promise<CommandResult> {
  const stripped = line.replace(/^[/:]+/, '').trim();
  if (!stripped) return { text: '空命令, 输入 /help 查看' };
  const parts = stripped.split(/\s+/);
  const name = parts[0]!.toLowerCase();
  const args = parts.slice(1);
  const handler = handlers[name];
  if (!handler) return { text: `未知命令: /${name}, 输入 /help 查看可用命令` };
  return handler(args, ctx);
}

export async function preloadModels(): Promise<void> {
  await listModels().catch(() => {
    /* offline ok */
  });
}
