import readline from 'node:readline';
import type { ApprovalProvider, ApprovalRequest, ApprovalResult } from '../agent/approval.js';

export class CliApprovalProvider implements ApprovalProvider {
  async ask(req: ApprovalRequest): Promise<ApprovalResult> {
    process.stdout.write(`\n[!] 审批请求: ${req.toolName}\n`);
    process.stdout.write(`    ${req.summary}\n`);
    if (req.details) {
      const detail = req.details.length > 2000 ? `${req.details.slice(0, 2000)}\n... (截断)` : req.details;
      process.stdout.write(`---\n${detail}\n---\n`);
    }

    return new Promise<ApprovalResult>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const timer = setTimeout(() => {
        rl.close();
        process.stdout.write(`[审批超时, 拒绝]\n`);
        resolve({ decision: 'timeout', reason: `no input within ${req.timeoutMs}ms` });
      }, req.timeoutMs);

      rl.question('确认执行? [y/N]: ', (ans) => {
        clearTimeout(timer);
        rl.close();
        const normalized = ans.trim().toLowerCase();
        if (normalized === 'y' || normalized === 'yes') {
          resolve({ decision: 'approved' });
        } else {
          resolve({ decision: 'denied', reason: `user typed "${ans}"` });
        }
      });
    });
  }
}
