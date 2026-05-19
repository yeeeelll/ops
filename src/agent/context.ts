import type { ChatMessage } from './types.js';
import { config } from '../config.js';

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(msg: ChatMessage): number {
  let total = estimateTokens(msg.content ?? '');
  if (msg.tool_calls) total += estimateTokens(JSON.stringify(msg.tool_calls));
  total += 8;
  return total;
}

export function totalTokens(messages: ChatMessage[]): number {
  return messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
}

export interface TrimResult {
  messages: ChatMessage[];
  dropped: number;
  budget: number;
  used: number;
}

export interface TrimOptions {
  budget?: number;
  threshold?: number;
}

export function trimHistory(messages: ChatMessage[], opts: TrimOptions = {}): TrimResult {
  const budget = opts.budget ?? config.llm.contextBudget;
  const ratio = opts.threshold ?? config.llm.compactThreshold;
  const threshold = Math.floor(budget * ratio);
  let used = totalTokens(messages);
  if (used <= threshold) {
    return { messages, dropped: 0, budget, used };
  }

  const systemIdx = messages.findIndex((m) => m.role === 'system');
  const system = systemIdx >= 0 ? messages[systemIdx]! : null;
  const rest = system ? messages.slice(systemIdx + 1) : [...messages];

  let dropped = 0;
  while (used > threshold && rest.length > 2) {
    const removed = rest.shift();
    if (!removed) break;
    used -= estimateMessageTokens(removed);
    dropped += 1;
    while (rest.length > 0 && rest[0]?.role === 'tool') {
      const t = rest.shift()!;
      used -= estimateMessageTokens(t);
      dropped += 1;
    }
  }

  return {
    messages: system ? [system, ...rest] : rest,
    dropped,
    budget,
    used,
  };
}
