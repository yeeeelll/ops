import { logger } from '../logger.js';
import type {
  OpenAIToolSchema,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../agent/types.js';

const registry = new Map<string, ToolDefinition>();

export function registerTool(def: ToolDefinition): void {
  if (registry.has(def.name)) {
    throw new Error(`tool already registered: ${def.name}`);
  }
  registry.set(def.name, def);
  logger.debug({ tool: def.name }, 'tool registered');
}

export function getToolSchemas(): OpenAIToolSchema[] {
  return [...registry.values()].map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function listToolNames(): string[] {
  return [...registry.keys()];
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) {
    return { ok: false, content: `unknown tool: ${name}` };
  }
  return tool.handler(args, ctx);
}
