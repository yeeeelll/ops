import { logger } from '../logger.js';

export type ApprovalDecision = 'approved' | 'denied' | 'timeout';

export interface ApprovalRequest {
  sessionId: string;
  toolName: string;
  summary: string;
  details?: string;
  timeoutMs: number;
}

export interface ApprovalResult {
  decision: ApprovalDecision;
  reason?: string;
}

export interface ApprovalProvider {
  ask(req: ApprovalRequest): Promise<ApprovalResult>;
}

class DenyAllProvider implements ApprovalProvider {
  async ask(req: ApprovalRequest): Promise<ApprovalResult> {
    logger.warn({ tool: req.toolName }, 'no approval provider configured, denying by default');
    return { decision: 'denied', reason: 'no approval provider for this channel' };
  }
}

const providers = new Map<string, ApprovalProvider>();
const defaultProvider: ApprovalProvider = new DenyAllProvider();

export function registerApprovalProvider(channel: string, provider: ApprovalProvider): void {
  providers.set(channel, provider);
  logger.info({ channel }, 'approval provider registered');
}

export function getApprovalProvider(channel: string): ApprovalProvider {
  return providers.get(channel) ?? defaultProvider;
}
