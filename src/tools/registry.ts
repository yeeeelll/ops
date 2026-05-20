import { logger } from '../logger.js';
import { getApprovalProvider } from '../agent/approval.js';
import { config } from '../config.js';
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
  logger.debug({ tool: def.name, dangerous: def.dangerous ?? false }, 'tool registered');
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

export interface RunToolOutcome extends ToolResult {
  approval?: 'none' | 'approved' | 'denied' | 'timeout';
  approvalReason?: string | null;
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<RunToolOutcome> {
  const tool = registry.get(name);
  if (!tool) {
    return { ok: false, content: `unknown tool: ${name}`, approval: 'none' };
  }

  if (tool.dangerous) {
    const provider = getApprovalProvider(ctx.channel);
    let summary = `${name} 调用`;
    let details: string | undefined;
    if (tool.confirm) {
      try {
        const built = await tool.confirm(args);
        summary = built.summary;
        details = built.details;
      } catch (err) {
        logger.warn({ err, name }, 'confirm builder threw');
      }
    } else {
      details = JSON.stringify(args, null, 2);
    }
    const verdict = await provider.ask({
      sessionId: ctx.sessionId,
      toolName: name,
      summary,
      details,
      timeoutMs: config.tools.approvalTimeoutMs,
    });
    if (verdict.decision !== 'approved') {
      return {
        ok: false,
        content: `[审批${verdict.decision === 'timeout' ? '超时' : '拒绝'}] 操作未执行${verdict.reason ? `: ${verdict.reason}` : ''}`,
        approval: verdict.decision,
        approvalReason: verdict.reason ?? null,
      };
    }
    const result = await tool.handler(args, ctx);
    return { ...result, approval: 'approved' };
  }

  const result = await tool.handler(args, ctx);
  return { ...result, approval: 'none' };
}
