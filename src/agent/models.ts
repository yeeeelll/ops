import { config } from '../config.js';
import { logger } from '../logger.js';

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  supportsTools: boolean | null;
}

interface OpenRouterModelRaw {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  architecture?: { modality?: string };
}

const CACHE_TTL_MS = 60 * 60 * 1000;
let cache: { fetchedAt: number; list: ModelInfo[] } | null = null;
let inflight: Promise<ModelInfo[]> | null = null;

export async function listModels(force = false): Promise<ModelInfo[]> {
  const fresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (!force && fresh && cache) return cache.list;
  if (inflight) return inflight;

  inflight = (async (): Promise<ModelInfo[]> => {
    const url = `${config.llm.baseUrl}/models`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.llm.apiKey}`,
        'HTTP-Referer': config.llm.referer,
        'X-Title': config.llm.appName,
      },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`OpenRouter /models ${res.status}: ${txt.slice(0, 200)}`);
    }
    const body = (await res.json()) as { data?: OpenRouterModelRaw[] };
    const raw = body.data ?? [];
    const list = raw.map<ModelInfo>((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextLength: m.context_length ?? 4096,
      pricing: m.pricing
        ? { prompt: m.pricing.prompt, completion: m.pricing.completion }
        : undefined,
      supportsTools: Array.isArray(m.supported_parameters)
        ? m.supported_parameters.includes('tools')
        : null,
    }));
    cache = { fetchedAt: Date.now(), list };
    logger.info({ count: list.length }, 'OpenRouter models cached');
    return list;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export async function findModel(id: string): Promise<ModelInfo | null> {
  const all = await listModels();
  return all.find((m) => m.id === id) ?? null;
}

export async function searchModels(query: string, limit = 30): Promise<ModelInfo[]> {
  const all = await listModels();
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, limit);
  return all
    .filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    .slice(0, limit);
}

export function formatModelLine(m: ModelInfo): string {
  const ctx = m.contextLength >= 1000
    ? `${Math.round(m.contextLength / 1000)}K`
    : `${m.contextLength}`;
  const tools = m.supportsTools === true ? 'tools' : m.supportsTools === false ? 'no-tools' : '?';
  const price =
    m.pricing?.prompt && m.pricing?.completion
      ? `$${formatPrice(m.pricing.prompt)}/${formatPrice(m.pricing.completion)}`
      : '?';
  return `${m.id.padEnd(50)} ctx=${ctx.padEnd(6)} ${tools.padEnd(8)} ${price}`;
}

function formatPrice(p: string): string {
  const n = Number(p);
  if (!Number.isFinite(n)) return p;
  const perM = n * 1_000_000;
  return perM < 0.01 ? perM.toFixed(4) : perM.toFixed(2);
}

export function budgetForModel(m: ModelInfo): number {
  const ctx = m.contextLength;
  const usable = Math.floor(ctx * 0.85);
  return Math.min(usable, config.llm.contextBudget);
}
