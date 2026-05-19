import { config } from '../config.js';
import { logger } from '../logger.js';
import type {
  ChatCompletionResponse,
  ChatMessage,
  OpenAIToolSchema,
} from './types.js';

function isSameModel(requested: string, served: string): boolean {
  if (requested === served) return true;
  // OpenRouter often returns a date-stamped variant like
  // "deepseek/deepseek-v4-pro-20260423" for a request of "deepseek/deepseek-v4-pro".
  if (served.startsWith(`${requested}-`)) return true;
  return false;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: OpenAIToolSchema[];
  toolChoice?: 'auto' | 'none' | 'required';
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  allowFallbacks?: boolean;
}

export async function chatCompletion(req: ChatRequest): Promise<ChatCompletionResponse> {
  const url = `${config.llm.baseUrl}/chat/completions`;
  const requestedModel = req.model ?? config.llm.model;
  const body: Record<string, unknown> = {
    model: requestedModel,
    messages: req.messages,
    max_tokens: req.maxTokens ?? config.llm.maxTokens,
    temperature: req.temperature ?? 0.2,
    provider: {
      allow_fallbacks: req.allowFallbacks ?? false,
    },
  };
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools;
    body.tool_choice = req.toolChoice ?? 'auto';
  }

  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llm.apiKey}`,
      'HTTP-Referer': config.llm.referer,
      'X-Title': config.llm.appName,
    },
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error({ status: res.status, body: text.slice(0, 500) }, 'OpenRouter request failed');
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as ChatCompletionResponse;
  if (json.model && !isSameModel(requestedModel, json.model)) {
    logger.warn(
      { requested: requestedModel, served: json.model },
      'OpenRouter served a different model than requested',
    );
  }
  logger.info(
    {
      ms: Date.now() - started,
      requested: requestedModel,
      served: json.model,
      usage: json.usage,
      finish: json.choices[0]?.finish_reason,
    },
    'chat completion',
  );
  return json;
}
