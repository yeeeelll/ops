import { logger } from '../logger.js';
import { appendMessage, getSession, loadHistory } from '../store/session.js';
import { audit } from '../store/audit.js';
import { chatCompletion } from './llm.js';
import { trimHistory } from './context.js';
import { buildSystemPrompt } from './prompts.js';
import { budgetForModel, findModel } from './models.js';
import { config } from '../config.js';
import { getToolSchemas, runTool } from '../tools/registry.js';
import type { ChatMessage, ToolCall } from './types.js';

const MAX_ITERATIONS = 10;
const TOOL_RESULT_MAX_CHARS = 8_000;

export interface RunOptions {
  sessionId: string;
  channel: string;
  userInput: string;
  signal?: AbortSignal;
  onAssistantPartial?: (text: string) => void;
  onToolStart?: (call: ToolCall) => void;
  onToolEnd?: (call: ToolCall, ok: boolean, contentPreview: string) => void;
  onCompletion?: (info: { requestedModel: string; servedModel: string; iteration: number }) => void;
}

export interface RunResult {
  finalText: string;
  iterations: number;
  toolCalls: number;
  servedModel: string | null;
}

function truncate(text: string, max = TOOL_RESULT_MAX_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(-Math.floor(max * 0.25));
  return {
    text: `${head}\n\n... [truncated ${text.length - head.length - tail.length} chars] ...\n\n${tail}`,
    truncated: true,
  };
}

function ensureSystem(history: ChatMessage[], model: string): ChatMessage[] {
  const rest = history.filter((m) => m.role !== 'system');
  return [{ role: 'system', content: buildSystemPrompt({ model }) }, ...rest];
}

export async function runTurn(opts: RunOptions): Promise<RunResult> {
  const { sessionId, channel, userInput, signal } = opts;

  const userMsg: ChatMessage = { role: 'user', content: userInput };
  appendMessage(sessionId, userMsg);

  const session = getSession(sessionId);
  const model = session?.model ?? config.llm.model;
  const modelInfo = await findModel(model).catch(() => null);
  const budget = modelInfo ? budgetForModel(modelInfo) : config.llm.contextBudget;

  let history = ensureSystem(loadHistory(sessionId), model);
  const tools = getToolSchemas();

  let iterations = 0;
  let toolCallsTotal = 0;
  let finalText = '';
  let servedModel: string | null = null;

  while (iterations < MAX_ITERATIONS) {
    iterations += 1;
    const trimmed = trimHistory(history, { budget });
    if (trimmed.dropped > 0) {
      logger.warn({ dropped: trimmed.dropped, used: trimmed.used, budget }, 'context trimmed');
    }

    const res = await chatCompletion({
      messages: trimmed.messages,
      tools,
      toolChoice: 'auto',
      model,
      signal,
    });

    servedModel = res.model ?? servedModel;
    opts.onCompletion?.({
      requestedModel: model,
      servedModel: res.model ?? '(unknown)',
      iteration: iterations,
    });

    const choice = res.choices[0];
    if (!choice) throw new Error('LLM returned no choices');
    const assistant = choice.message;

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: assistant.content ?? '',
      ...(assistant.tool_calls ? { tool_calls: assistant.tool_calls } : {}),
    };
    appendMessage(sessionId, assistantMsg);
    history = [...history, assistantMsg];

    if (assistant.content && opts.onAssistantPartial) opts.onAssistantPartial(assistant.content);

    if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
      finalText = assistant.content ?? '';
      break;
    }

    for (const call of assistant.tool_calls) {
      toolCallsTotal += 1;
      opts.onToolStart?.(call);
      const started = Date.now();
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch (err) {
        logger.warn({ err, raw: call.function.arguments }, 'tool args parse failed');
      }

      let resultText: string;
      let ok = false;
      try {
        const r = await runTool(call.function.name, parsedArgs, {
          sessionId,
          channel,
          signal,
        });
        ok = r.ok;
        const t = truncate(r.content);
        resultText = t.text;
        audit({
          sessionId,
          tool: call.function.name,
          args: parsedArgs,
          result: resultText.slice(0, 4000),
          status: r.ok ? 'ok' : 'error',
          durationMs: Date.now() - started,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        resultText = `tool error: ${msg}`;
        audit({
          sessionId,
          tool: call.function.name,
          args: parsedArgs,
          result: msg,
          status: 'error',
          durationMs: Date.now() - started,
        });
      }

      const toolMsg: ChatMessage = {
        role: 'tool',
        content: resultText,
        tool_call_id: call.id,
        name: call.function.name,
      };
      appendMessage(sessionId, toolMsg);
      history = [...history, toolMsg];
      opts.onToolEnd?.(call, ok, resultText.slice(0, 200));
    }
  }

  if (iterations >= MAX_ITERATIONS) {
    logger.warn({ sessionId }, 'agent loop reached MAX_ITERATIONS');
    finalText = finalText || '(达到最大工具调用迭代次数, 已中止)';
  }

  return { finalText, iterations, toolCalls: toolCallsTotal, servedModel };
}
